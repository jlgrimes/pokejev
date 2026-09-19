#!/usr/bin/env node
/**
 * Bundle each serverless route into a self-contained file.
 *
 * Vercel's Node builder transpiles TypeScript routes but does not bundle them,
 * so relative import specifiers survive into the deployed output and fail to
 * resolve at runtime. Pre-bundling removes every relative import, leaving only
 * bare specifiers for packages Vercel installs anyway.
 *
 * Sources live in server/; api/ holds only the generated output.
 */
import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_DIR = 'server';
const OUTPUT_DIR = 'api';

const entries = (await readdir(SOURCE_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(SOURCE_DIR, entry.name));

if (entries.length === 0) {
  console.error(`No route sources found in ${SOURCE_DIR}/`);
  process.exit(1);
}

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

await build({
  entryPoints: entries,
  outdir: OUTPUT_DIR,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Leave real dependencies alone: Vercel installs them, and bundling
  // serverboy into five copies would bloat every function.
  packages: 'external',
  logLevel: 'warning',
});

const built = (await readdir(OUTPUT_DIR)).filter((name) => name.endsWith('.js'));
console.log(`Bundled ${built.length} routes → ${OUTPUT_DIR}/: ${built.join(", ")}`);
