#!/usr/bin/env -S npx tsx
/**
 * Upload your own Pokemon Red dump to the deployment's private Blob store.
 *
 * The ROM is never committed and never served publicly: it lives in private
 * Blob storage in your own Vercel account, and only the deployed functions can
 * read it.
 *
 *   npm run upload-rom -- roms/pokemon_red.gb
 */
import { readFileSync } from 'node:fs';
import { put, head } from '@vercel/blob';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env, rely on the ambient environment */
}

const path = process.argv[2] ?? process.env.ROM_PATH ?? 'roms/pokemon_red.gb';
const key = process.env.ROM_BLOB_KEY ?? 'rom/pokemon_red.gb';

// Either an explicit read-write token, or OIDC plus the store id — which is
// what `vercel env pull` gives you once a store is connected to the project.
const hasCredentials =
  Boolean(process.env.BLOB_READ_WRITE_TOKEN) ||
  Boolean(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN);

if (!hasCredentials) {
  console.error(
    '\nNo Blob credentials found.\n' +
      'Connect a Blob store to the project in the Vercel dashboard (Storage → Blob),\n' +
      'then run `vercel env pull .env` to fetch BLOB_STORE_ID and VERCEL_OIDC_TOKEN.\n' +
      '(A BLOB_READ_WRITE_TOKEN from the store\'s settings also works.)\n',
  );
  process.exit(1);
}

const rom = readFileSync(path);

// Sanity-check the cartridge header before uploading a megabyte of something else.
const title = rom.subarray(0x134, 0x143).toString('ascii').replace(/\0+$/, '').trim();
const hasNintendoLogo = rom[0x104] === 0xce && rom[0x105] === 0xed;

if (!hasNintendoLogo) {
  console.error(`\n${path} does not look like a Game Boy ROM (no cartridge header).\n`);
  process.exit(1);
}
if (!/POKEMON RED/i.test(title)) {
  console.warn(`\nWarning: cartridge title is "${title}", expected "POKEMON RED".`);
  console.warn('Jev\'s memory map is written for Pokemon Red (US) and will misread other games.\n');
}

console.log(`Uploading ${path} (${(rom.length / 1024 / 1024).toFixed(2)} MB, title "${title}") → ${key}`);

const blob = await put(key, rom, {
  access: 'private',
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: 'application/octet-stream',
});

const check = await head(blob.url).catch(() => null);
console.log(`\nDone. Stored privately as ${blob.pathname}${check ? ` (${check.size} bytes)` : ''}.`);
console.log('It is not publicly readable — only your deployed functions can fetch it.\n');
