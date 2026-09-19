import { put, get, del, head } from '@vercel/blob';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
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
  /** Size in bytes if the object exists, otherwise null. Avoids downloading it. */
  stat(key: string): Promise<number | null>;
  kind: 'blob' | 'local';
}

/**
 * Resolved per call rather than at import time.
 *
 * The long-lived server points this at its data directory, and an import-time
 * constant would capture the default before that happens — writing beside the
 * image instead of the mounted volume, so nothing would survive a redeploy.
 */
const localRoot = () => process.env.LOCAL_STORAGE_DIR ?? '.data';

const localStorage: Storage = {
  kind: 'local',
  async read(key) {
    try {
      return await readFile(join(localRoot(), key));
    } catch {
      return null;
    }
  },
  async write(key, data) {
    const path = join(localRoot(), key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  async remove(key) {
    await unlink(join(localRoot(), key)).catch(() => {});
  },
  async stat(key) {
    return await stat(join(localRoot(), key))
      .then((info) => info.size)
      .catch(() => null);
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
  async stat(key) {
    // head() fetches metadata only, so checking for a 1MB ROM costs nothing.
    // It takes no access option: credentials already scope it to our store.
    const info = await head(key).catch(() => null);
    return info?.size ?? null;
  },
};

/**
 * Whether the Blob SDK can authenticate.
 *
 * Two routes, and the deployed one does NOT involve a token: when a store is
 * connected to a Vercel project, the SDK authenticates with the deployment's
 * own OIDC token and only needs BLOB_STORE_ID to know which store to talk to.
 * BLOB_READ_WRITE_TOKEN is the explicit alternative, used outside Vercel.
 */
export function hasBlobCredentials(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export function getStorage(): Storage {
  if (hasBlobCredentials()) return blobStorage;

  // A deployed function has no writable working directory, so falling back to
  // the filesystem here would fail later with an opaque EROFS. Say what is
  // actually missing instead.
  if (process.env.VERCEL) {
    throw new Error(
      'No Blob store is connected to this project. Create one in the Vercel ' +
        'dashboard (Storage → Create Database → Blob), connect it to this project, ' +
        'and redeploy so BLOB_STORE_ID is available to the functions.',
    );
  }

  return localStorage;
}
