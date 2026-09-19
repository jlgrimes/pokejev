import { inflateRawSync } from 'node:zlib';

/**
 * Minimal zip reader — just enough to pull one file out of an archive.
 *
 * ROMs are almost always distributed zipped, and asking someone on a phone to
 * unzip one first is a real obstacle. Reads the central directory rather than
 * the local headers, because entries written with a streaming data descriptor
 * carry zero sizes in their local header.
 */
export interface ZipEntry {
  name: string;
  size: number;
  read(): Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export function listZipEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  if (eocd === -1) return [];

  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > archive.length) break;
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;

    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    entries.push({
      name,
      size: uncompressedSize,
      read(): Buffer {
        // The local header repeats the name/extra lengths, and they can differ
        // from the central directory's, so the data offset must come from here.
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = archive.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`Unsupported zip compression method ${method} for "${name}"`);
      },
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function isZip(data: Buffer): boolean {
  return data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // The record is at the very end unless there is a trailing comment, which is
  // at most 64KB, so scanning backwards over that window always finds it.
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let i = archive.length - 22; i >= earliest; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
