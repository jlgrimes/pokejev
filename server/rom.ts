import { getStorage } from './_lib/storage.ts';
import { ROM_KEY } from './_lib/rom.ts';
import { json, fail } from './_lib/http.ts';
import { listZipEntries, isZip } from './_lib/zip.ts';
import { inspectRom } from '../src/game/rom.ts';

/** Generous enough for a zipped 1MB ROM, tight enough to reject nonsense. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Install the ROM from the browser.
 *
 * The deployment can reach Blob with its own OIDC credentials, so uploading
 * through the running app avoids needing a CLI, a token, or a computer at all.
 * The route inherits the project's Vercel Authentication, so only someone who
 * can already open the app can put a ROM in it.
 *
 * Accepts a raw .gb body or a .zip (ROMs are nearly always distributed zipped,
 * and unzipping on a phone is exactly the kind of friction worth removing).
 */
/** Whether a ROM is already installed, so the page knows what to show. */
export async function GET(): Promise<Response> {
  try {
    const size = await getStorage().stat(ROM_KEY);
    return json({ present: size !== null, size, key: ROM_KEY });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const storage = getStorage();

  try {
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length === 0) return json({ error: 'No file was uploaded.' }, 400);
    if (body.length > MAX_UPLOAD_BYTES) {
      return json({ error: `That file is ${(body.length / 1024 / 1024).toFixed(1)}MB; the limit is 8MB.` }, 413);
    }

    const { rom, source } = extractRom(body);
    if (!rom) {
      return json(
        { error: source ?? 'That archive does not contain a .gb file.' },
        400,
      );
    }

    const info = inspectRom(rom);
    if (!info.valid) {
      return json({ error: info.problems.join('; '), info }, 400);
    }

    await storage.write(ROM_KEY, rom, 'application/octet-stream');

    return json({
      ok: true,
      key: ROM_KEY,
      title: info.title,
      size: info.size,
      source,
      warnings: info.warnings,
    });
  } catch (error) {
    return fail(error);
  }
}

/** Pull a ROM out of the upload, unwrapping a zip if that is what arrived. */
function extractRom(body: Buffer): { rom: Buffer | null; source: string } {
  if (!isZip(body)) return { rom: body, source: 'uploaded file' };

  const entries = listZipEntries(body);
  const candidate = entries.find((entry) => /\.gbc?$/i.test(entry.name));
  if (!candidate) {
    const names = entries.map((entry) => entry.name).join(', ');
    return {
      rom: null,
      source: `The archive contains no .gb file (found: ${names || 'nothing readable'}).`,
    };
  }

  return { rom: candidate.read(), source: `${candidate.name} (from the zip)` };
}
