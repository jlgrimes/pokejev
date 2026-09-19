import { put, get, del } from '@vercel/blob';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Object storage for the deployed harness.
 *
 * Vercel Blob in production (private access — the ROM and save states are
 * never publicly reachable), the local filesystem when developing, so the same
 * code runs in both places without a token.
 */
export interface Storage {
  read(key: string): Promise<Buffer | null>;
  write(key: string, data: Buffer, contentType?: string): Promise<void>;
  remove(key: string): Promise<void>;
  kind: 'blob' | 'local';
}

const LOCAL_ROOT = process.env.LOCAL_STORAGE_DIR ?? '.data';

const localStorage: Storage = {
  kind: 'local',
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
    await unlink(join(LOCAL_ROOT, key)).catch(() => {});
  },
};

const blobStorage: Storage = {
  kind: 'blob',
  async read(key) {
    // useCache:false matters: session state changes every tick, and a CDN-cached
    // read would hand the next tick a stale Game Boy.
    const result = await get(key, { access: 'private', useCache: false }).catch(() => null);
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },
  async write(key, data, contentType = 'application/octet-stream') {
    await put(key, data, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 0,
    });
  },
  async remove(key) {
    await del(key).catch(() => {});
  },
};

export function getStorage(): Storage {
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStorage : localStorage;
}
