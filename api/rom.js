// server/_lib/storage.ts
import { put, get, del, head } from "@vercel/blob";
import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
var LOCAL_ROOT = process.env.LOCAL_STORAGE_DIR ?? ".data";
var localStorage = {
  kind: "local",
  async read(key) {
    try {
      return await readFile(join(LOCAL_ROOT, key));
    } catch {
      return null;
    }
  },
  async write(key, data) {
    const path = join(LOCAL_ROOT, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  async remove(key) {
    await unlink(join(LOCAL_ROOT, key)).catch(() => {
    });
  },
  async stat(key) {
    return await stat(join(LOCAL_ROOT, key)).then((info) => info.size).catch(() => null);
  }
};
var blobStorage = {
  kind: "blob",
  async read(key) {
    const result = await get(key, { access: "private", useCache: false }).catch(() => null);
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const chunks = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },
  async write(key, data, contentType = "application/octet-stream") {
    await put(key, data, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 0
    });
  },
  async remove(key) {
    await del(key).catch(() => {
    });
  },
  async stat(key) {
    const info = await head(key).catch(() => null);
    return info?.size ?? null;
  }
};
function hasBlobCredentials() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}
function getStorage() {
  if (hasBlobCredentials()) return blobStorage;
  if (process.env.VERCEL) {
    throw new Error(
      "No Blob store is connected to this project. Create one in the Vercel dashboard (Storage \u2192 Create Database \u2192 Blob), connect it to this project, and redeploy so BLOB_STORE_ID is available to the functions."
    );
  }
  return localStorage;
}

// server/_lib/rom.ts
var ROM_KEY = process.env.ROM_BLOB_KEY ?? "rom/pokemon_red.gb";

// server/_lib/http.ts
var JSON_HEADERS = {
  "content-type": "application/json",
  // Every response reflects a mutating tick; caching any of it would desync
  // the browser from the emulator.
  "cache-control": "no-store"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function fail(error, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, status);
}

// server/_lib/zip.ts
import { inflateRawSync } from "node:zlib";
var EOCD_SIGNATURE = 101010256;
var CENTRAL_SIGNATURE = 33639248;
function listZipEntries(archive) {
  const eocd = findEndOfCentralDirectory(archive);
  if (eocd === -1) return [];
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries = [];
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
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      size: uncompressedSize,
      read() {
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = archive.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`Unsupported zip compression method ${method} for "${name}"`);
      }
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function isZip(data) {
  return data.length > 4 && data.readUInt32LE(0) === 67324752;
}
function findEndOfCentralDirectory(archive) {
  const earliest = Math.max(0, archive.length - 65535 - 22);
  for (let i = archive.length - 22; i >= earliest; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// src/game/rom.ts
var LOGO_START = [206, 237, 102, 102];
function inspectRom(rom) {
  const problems = [];
  const warnings = [];
  const isGameBoy = rom.length >= 336 && LOGO_START.every((byte, i) => rom[260 + i] === byte);
  if (!isGameBoy) problems.push("not a Game Boy ROM (the cartridge header is missing)");
  const title = isGameBoy ? Buffer.from(rom.subarray(308, 323)).toString("ascii").replace(/\0+$/, "").trim() : "";
  let checksum = 0;
  for (let i = 308; i <= 332; i++) checksum = checksum - (rom[i] ?? 0) - 1 & 255;
  const headerChecksumOk = isGameBoy && checksum === rom[333];
  if (isGameBoy && !headerChecksumOk) {
    warnings.push("header checksum does not match \u2014 the dump may be corrupt");
  }
  const isPokemonRed = /POKEMON RED/i.test(title);
  if (isGameBoy && !isPokemonRed) {
    problems.push(
      `cartridge title is "${title}", expected "POKEMON RED" \u2014 Jev's memory map is written for Pokemon Red and would misread another game`
    );
  }
  if (isGameBoy && rom.length !== 1024 * 1024) {
    warnings.push(`unusual size ${rom.length} bytes; Pokemon Red is exactly 1MB`);
  }
  return {
    valid: problems.length === 0,
    title,
    size: rom.length,
    isGameBoy,
    isPokemonRed,
    headerChecksumOk,
    problems,
    warnings
  };
}

// server/rom.ts
var config = { maxDuration: 60 };
var MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
async function handler(request) {
  const storage = getStorage();
  if (request.method === "GET") {
    try {
      const size = await storage.stat(ROM_KEY);
      return json({ present: size !== null, size, key: ROM_KEY });
    } catch (error) {
      return fail(error);
    }
  }
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length === 0) return json({ error: "No file was uploaded." }, 400);
    if (body.length > MAX_UPLOAD_BYTES) {
      return json({ error: `That file is ${(body.length / 1024 / 1024).toFixed(1)}MB; the limit is 8MB.` }, 413);
    }
    const { rom, source } = extractRom(body);
    if (!rom) {
      return json(
        { error: source ?? "That archive does not contain a .gb file." },
        400
      );
    }
    const info = inspectRom(rom);
    if (!info.valid) {
      return json({ error: info.problems.join("; "), info }, 400);
    }
    await storage.write(ROM_KEY, rom, "application/octet-stream");
    return json({
      ok: true,
      key: ROM_KEY,
      title: info.title,
      size: info.size,
      source,
      warnings: info.warnings
    });
  } catch (error) {
    return fail(error);
  }
}
function extractRom(body) {
  if (!isZip(body)) return { rom: body, source: "uploaded file" };
  const entries = listZipEntries(body);
  const candidate = entries.find((entry) => /\.gbc?$/i.test(entry.name));
  if (!candidate) {
    const names = entries.map((entry) => entry.name).join(", ");
    return {
      rom: null,
      source: `The archive contains no .gb file (found: ${names || "nothing readable"}).`
    };
  }
  return { rom: candidate.read(), source: `${candidate.name} (from the zip)` };
}
export {
  config,
  handler as default
};
