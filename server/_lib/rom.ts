import { readFile } from 'node:fs/promises';
import { getStorage } from './storage.ts';

/**
 * The ROM, cached in module scope.
 *
 * Serverless invocations that land on a warm instance reuse this, so the 1MB
 * fetch from Blob happens once per container rather than once per tick.
 */
let cached: Buffer | null = null;

export const ROM_KEY = process.env.ROM_BLOB_KEY ?? 'rom/pokemon_red.gb';

export async function loadRom(): Promise<Buffer> {
  if (cached) return cached;

  // A local path wins when present, which keeps `vercel dev` and tests offline.
  const localPath = process.env.ROM_PATH;
  if (localPath) {
    const local = await readFile(localPath).catch(() => null);
    if (local) {
      cached = local;
      return cached;
    }
  }

  const stored = await getStorage().read(ROM_KEY);
  if (!stored) {
    throw new Error(
      `No ROM found at "${ROM_KEY}". Upload your own Pokemon Red dump with ` +
        `\`npm run upload-rom -- <path-to-rom.gb>\` before starting a run.`,
    );
  }
  cached = stored;
  return cached;
}

export function romIsCached(): boolean {
  return cached !== null;
}
