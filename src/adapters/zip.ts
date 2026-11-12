import { crc32 as nodeCrc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  maxBytes?: number;
  maxMembers?: number;
  allowNested?: boolean;
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  getData: () => Buffer;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
const DEFAULT_MAX_MEMBERS = 10000;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Computes CRC-32 using node:zlib if available, or a table-driven fallback.
 */
export function computeCrc32(buf: Buffer): number {
  if (typeof nodeCrc32 === 'function') {
    return nodeCrc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CP437_CHARS =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσμτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else {
      out += CP437_CHARS[b - 0x80] ?? String.fromCharCode(b);
    }
  }
  return out;
}

function decodeEntryName(buf: Buffer, offset: number, len: number, flags: number): string {
  const slice = buf.subarray(offset, offset + len);
  const isBit11 = (flags & (1 << 11)) !== 0;
  if (isBit11) {
    return slice.toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return decodeCp437(slice);
  }
}

interface ZipCounter {
  totalBytes: number;
  totalMembers: number;
}

interface RawEntry {
  cleanName: string;
  isDirectory: boolean;
  method: number;
  expectedCrc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readZipInternal(
  buffer: Buffer,
  limits: ZipLimits,
  counter: ZipCounter,
  depth: number
): ZipEntry[] {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxMembers = limits.maxMembers ?? DEFAULT_MAX_MEMBERS;
  const allowNested = limits.allowNested ?? true;

  if (buffer.length < 22) {
    throw new Error('Invalid zip file: buffer too small');
  }

  // Find End of Central Directory (EOCD) signature: 0x06054b50
  let eocdOffset = -1;
  const maxSearch = Math.min(buffer.length - 22, 65535 + 22);
  for (let i = buffer.length - 22; i >= buffer.length - maxSearch; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip file: End of Central Directory signature not found');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries === 0xffff || centralDirOffset === 0xffffffff || centralDirSize === 0xffffffff) {
    throw new Error('Zip64 format is not supported');
  }

  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('Invalid zip file: Central directory out of bounds');
  }

  const rawEntries: RawEntry[] = [];
  let cdOffset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cdOffset + 46 > buffer.length) {
      throw new Error('Invalid zip file: Truncated central directory header');
    }

    const sig = buffer.readUInt32LE(cdOffset);
    if (sig !== 0x02014b50) {
      throw new Error(`Invalid central directory header signature at offset ${cdOffset}`);
    }

    const flags = buffer.readUInt16LE(cdOffset + 8);
    if ((flags & 1) !== 0) {
      throw new Error('Encrypted zip entries are not supported');
    }

    const method = buffer.readUInt16LE(cdOffset + 10);
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported zip compression method: ${method}`);
    }

    const expectedCrc = buffer.readUInt32LE(cdOffset + 16);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);
    const fileNameLen = buffer.readUInt16LE(cdOffset + 28);
    const extraLen = buffer.readUInt16LE(cdOffset + 30);
    const commentLen = buffer.readUInt16LE(cdOffset + 32);
    const externalAttr = buffer.readUInt32LE(cdOffset + 38);
    const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);

    // Check for Unix symlink in external attributes
    const unixMode = (externalAttr >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Error('Zip symlink entries are not allowed');
    }

    const rawName = decodeEntryName(buffer, cdOffset + 46, fileNameLen, flags);
    const cleanName = rawName.replace(/\\/g, '/');

    // Path security checks
    if (cleanName.startsWith('/') || /^[a-zA-Z]:/.test(cleanName)) {
      throw new Error(`Zip entry with absolute path is not allowed: ${cleanName}`);
    }

    const parts = cleanName.split('/');
    if (parts.includes('..')) {
      throw new Error(`Zip entry with path traversal (..) is not allowed: ${cleanName}`);
    }

    const isDirectory = cleanName.endsWith('/');

    rawEntries.push({
      cleanName,
      isDirectory,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cdOffset += 46 + fileNameLen + extraLen + commentLen;
  }

  function makeZipEntry(raw: RawEntry): ZipEntry {
    const { cleanName, isDirectory, method, expectedCrc, compressedSize, uncompressedSize, localHeaderOffset } = raw;

    const entryDataGetter = (): Buffer => {
      if (localHeaderOffset < 0 || localHeaderOffset + 30 > buffer.length) {
        throw new Error(`Invalid zip file: Local header out of bounds for ${cleanName}`);
      }

      const localSig = buffer.readUInt32LE(localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new Error(`Invalid local header signature for ${cleanName}`);
      }

      const localFileNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;

      if (
        dataStart < localHeaderOffset + 30 ||
        dataStart + compressedSize > buffer.length ||
        dataStart + compressedSize < dataStart
      ) {
        throw new Error(`Invalid zip file: Data out of bounds for ${cleanName}`);
      }

      // A stored empty member has no data. A deflated empty member still has a few bytes of deflate
      // stream (zip tools write them), so it takes the normal path below, which checks size 0 and CRC.
      if (uncompressedSize === 0 && method === 0) {
        if (compressedSize !== 0) {
          throw new Error(`Invalid zip file: Non-zero compressed size for empty entry ${cleanName}`);
        }
        if (expectedCrc !== 0) {
          throw new Error(
            `Zip entry "${cleanName}" CRC-32 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x0`
          );
        }
        return Buffer.alloc(0);
      }

      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
      let decompressed: Buffer;

      if (method === 0) {
        if (compressedSize !== uncompressedSize) {
          throw new Error(
            `Zip entry "${cleanName}" stored size mismatch: compressed ${compressedSize} != uncompressed ${uncompressedSize}`
          );
        }
        decompressed = Buffer.from(compressedData);
      } else if (method === 8) {
        try {
          // zlib refuses a limit of 0; an empty member still has to inflate to exactly 0 bytes (checked below).
          decompressed = inflateRawSync(compressedData, { maxOutputLength: Math.max(1, uncompressedSize) });
        } catch (err) {
          throw new Error(`Failed to decompress zip entry "${cleanName}": ${(err as Error).message}`);
        }
      } else {
        throw new Error(`Unsupported zip compression method: ${method}`);
      }

      if (decompressed.length !== uncompressedSize) {
        throw new Error(
          `Zip entry "${cleanName}" decompressed size mismatch: expected ${uncompressedSize}, got ${decompressed.length}`
        );
      }

      const actualCrc = computeCrc32(decompressed);
      if (actualCrc !== expectedCrc) {
        throw new Error(
          `Zip entry "${cleanName}" CRC-32 mismatch: expected 0x${expectedCrc.toString(16).padStart(8, '0')}, got 0x${actualCrc.toString(16).padStart(8, '0')}`
        );
      }

      return decompressed;
    };

    return {
      name: cleanName,
      size: uncompressedSize,
      compressedSize,
      isDirectory,
      getData: entryDataGetter,
    };
  }

  // Handle one level of nested ZIPs at depth === 0
  if (depth === 0 && allowNested) {
    const innerZipRawEntries = rawEntries.filter(
      (e) => !e.isDirectory && e.cleanName.toLowerCase().endsWith('.zip')
    );

    if (innerZipRawEntries.length > 0) {
      // Sort inner zips naturally so Part-1 is processed before Part-2
      innerZipRawEntries.sort((a, b) =>
        a.cleanName.localeCompare(b.cleanName, undefined, { numeric: true })
      );

      const nonZipRawEntries = rawEntries.filter(
        (e) => e.isDirectory || !e.cleanName.toLowerCase().endsWith('.zip')
      );

      const resultEntries: ZipEntry[] = [];
      for (const raw of nonZipRawEntries) {
        counter.totalMembers++;
        if (counter.totalMembers > maxMembers) {
          throw new Error(`Zip member limit exceeded: ${counter.totalMembers} > ${maxMembers}`);
        }
        counter.totalBytes += raw.uncompressedSize;
        if (counter.totalBytes > maxBytes) {
          throw new Error(
            `Zip total uncompressed size limit exceeded: ${counter.totalBytes} > ${maxBytes}`
          );
        }
        resultEntries.push(makeZipEntry(raw));
      }

      for (const innerRaw of innerZipRawEntries) {
        const innerEntry = makeZipEntry(innerRaw);
        const innerBuf = innerEntry.getData();
        const innerEntries = readZipInternal(innerBuf, limits, counter, depth + 1);
        resultEntries.push(...innerEntries);
      }

      return resultEntries;
    }
  }

  const entries: ZipEntry[] = [];
  for (const raw of rawEntries) {
    counter.totalMembers++;
    if (counter.totalMembers > maxMembers) {
      throw new Error(`Zip member limit exceeded: ${counter.totalMembers} > ${maxMembers}`);
    }
    counter.totalBytes += raw.uncompressedSize;
    if (counter.totalBytes > maxBytes) {
      throw new Error(
        `Zip total uncompressed size limit exceeded: ${counter.totalBytes} > ${maxBytes}`
      );
    }
    entries.push(makeZipEntry(raw));
  }

  return entries;
}

/**
 * Reads a ZIP archive from a buffer safely.
 * Rejects absolute paths, path traversal (..), symlinks, encryption, and Zip64.
 * Enforces size and entry-count limits.
 * Supports one level of nested zips, verifying maxOutputLength and CRC-32.
 */
export function readZip(buffer: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  const counter: ZipCounter = { totalBytes: 0, totalMembers: 0 };
  return readZipInternal(buffer, limits, counter, 0);
}

export interface ZipMember {
  name: string;
  data: Buffer;
}

/**
 * Writes a ZIP archive (deflate, UTF-8 names, no Zip64). Deterministic: every member carries the
 * DOS epoch (1980-01-01), so the same members give the same bytes. Names are used as given and
 * must be relative; the reader above refuses anything else.
 */
export function writeZip(members: ZipMember[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of members) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = data.length ? deflateRawSync(data) : Buffer.alloc(0);
    const method = data.length ? 8 : 0;
    const crc = computeCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time 00:00:00
    local.writeUInt16LE(0x0021, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
