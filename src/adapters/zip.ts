import { inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  maxBytes?: number;
  maxMembers?: number;
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

/**
 * Reads a ZIP archive from a buffer safely.
 * Rejects absolute paths, path traversal (..), symlinks, encryption, and Zip64.
 * Enforces size and entry-count limits.
 */
export function readZip(buffer: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxMembers = limits.maxMembers ?? DEFAULT_MAX_MEMBERS;

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

  if (totalEntries > maxMembers) {
    throw new Error(`Zip member limit exceeded: ${totalEntries} > ${maxMembers}`);
  }

  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('Invalid zip file: Central directory out of bounds');
  }

  const entries: ZipEntry[] = [];
  let cdOffset = centralDirOffset;
  let totalUncompressed = 0;

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

    const rawName = buffer.toString('utf8', cdOffset + 46, cdOffset + 46 + fileNameLen);
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

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxBytes) {
      throw new Error(`Zip total uncompressed size limit exceeded: ${totalUncompressed} > ${maxBytes}`);
    }

    const entryDataGetter = (): Buffer => {
      if (uncompressedSize === 0) return Buffer.alloc(0);
      if (localHeaderOffset + 30 > buffer.length) {
        throw new Error(`Invalid zip file: Local header out of bounds for ${cleanName}`);
      }

      const localSig = buffer.readUInt32LE(localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new Error(`Invalid local header signature for ${cleanName}`);
      }

      const localFileNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;

      if (dataStart + compressedSize > buffer.length) {
        throw new Error(`Invalid zip file: Data out of bounds for ${cleanName}`);
      }

      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        return Buffer.from(compressedData);
      }
      return inflateRawSync(compressedData);
    };

    entries.push({
      name: cleanName,
      size: uncompressedSize,
      compressedSize,
      isDirectory,
      getData: entryDataGetter,
    });

    cdOffset += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}
