const BLOCK = 512;
export interface TarInput { name: string; type?: 'file' | 'directory'; data?: Uint8Array }
export interface TarMember { name: string; type: string; size: number; mode: number; linkname: string; data: Buffer }

export class TarUnsafeNameError extends Error {
  readonly memberName: string;
  constructor(memberName: string) { super('Tar name contains bytes after NUL'); this.memberName = memberName; }
}

function stringField(header: Buffer, start: number, size: number): string {
  const field = header.subarray(start, start + size);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? size : end).toString('utf8');
}
function octal(header: Buffer, start: number, size: number): number {
  const text = stringField(header, start, size).trim();
  if (text && !/^[0-7]+$/.test(text)) throw new Error('Invalid tar numeric field');
  const value = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new Error('Tar numeric field exceeds safe range');
  return value;
}
function putOctal(header: Buffer, start: number, size: number, value: number): void {
  const text = value.toString(8);
  if (text.length > size - 1) throw new Error('Tar numeric field overflow');
  header.write(text.padStart(size - 1, '0') + '\0', start, size, 'ascii');
}
function splitName(name: string): [string, string] {
  if (Buffer.byteLength(name) <= 100) return ['', name];
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i), leaf = name.slice(i + 1);
    if (leaf && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(leaf) <= 100) return [prefix, leaf];
  }
  throw new Error(`Tar name too long: ${name}`);
}
export function writeTar(members: TarInput[]): Buffer {
  const chunks: Buffer[] = [];
  const entries = members.map(m => ({ ...m, name: m.type === 'directory' && !m.name.endsWith('/') ? m.name + '/' : m.name }));
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const member of entries) {
    const dir = member.type === 'directory';
    if (member.type && member.type !== 'directory' && member.type !== 'file') throw new Error('Unsupported tar member type');
    const data = Buffer.from(member.data ?? []);
    if (dir && data.length) throw new Error('Directory cannot have data');
    const [prefix, name] = splitName(member.name);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100); putOctal(header, 100, 8, dir ? 0o755 : 0o644);
    putOctal(header, 108, 8, 0); putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, data.length); putOctal(header, 136, 12, 0);
    header.fill(32, 148, 156); header.write(dir ? '5' : '0', 156);
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); header.write(prefix, 345, 155);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, data, Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
export function readTar(bytes: Uint8Array): TarMember[] {
  const buffer = Buffer.from(bytes), members: TarMember[] = [];
  if (buffer.length % BLOCK) throw new Error('Truncated tar archive');
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every(b => b === 0)) {
      if (offset + BLOCK * 2 > buffer.length || !buffer.subarray(offset).every(b => b === 0)) throw new Error('Invalid tar terminator');
      return members;
    }
    const stored = octal(header, 148, 8);
    let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== stored) throw new Error('Invalid tar checksum');
    const name = stringField(header, 0, 100), prefix = stringField(header, 345, 155);
    for (const [start, length] of [[0, 100], [345, 155]]) {
      const field = header.subarray(start, start + length), nul = field.indexOf(0);
      if (nul >= 0 && field.subarray(nul + 1).some(byte => byte !== 0)) {
        let end = field.length; while (end > 0 && field[end - 1] === 0) end--;
        const invalid = field.subarray(0, end).toString('utf8');
        throw new TarUnsafeNameError(start === 0 ? (prefix ? `${prefix}/${invalid}` : invalid) : `${invalid}/${name}`);
      }
    }
    const size = octal(header, 124, 12), mode = octal(header, 100, 8);
    const start = offset + BLOCK, end = start + size;
    if (end > buffer.length || start + Math.ceil(size / BLOCK) * BLOCK > buffer.length) throw new Error('Truncated tar member');
    members.push({ name: prefix ? `${prefix}/${name}` : name, type: String.fromCharCode(header[156] || 48), size, mode, linkname: stringField(header, 157, 100), data: buffer.subarray(start, end) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error('Missing tar terminator');
}
