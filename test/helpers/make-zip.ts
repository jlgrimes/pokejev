import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Builds a real zip archive in memory so the reader can be tested against both
 * compression methods without shipping a fixture file.
 */
export function makeZip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.store ? 0 : 8;
    const payload = file.store ? file.data : deflateRawSync(file.data);
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/** A test ROM doctored to carry Pokemon Red's cartridge title. */
export function asPokemonRed(rom: Buffer): Buffer {
  const patched = Buffer.from(rom);
  patched.fill(0, 0x134, 0x143);
  Buffer.from('POKEMON RED').copy(patched, 0x134);
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - patched[i]! - 1) & 0xff;
  patched[0x14d] = checksum;
  return patched;
}
