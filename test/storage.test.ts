import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hasBlobCredentials, getStorage } from '../api/_lib/storage.ts';

/**
 * Credential detection has two valid routes and only one of them involves a
 * token. A deployed Vercel project with a Blob store connected gets
 * BLOB_STORE_ID and authenticates via OIDC — no BLOB_READ_WRITE_TOKEN is ever
 * injected — so gating on the token alone would break every deployed run.
 */
const KEYS = ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'VERCEL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('blob credential detection', () => {
  test('accepts a store id alone, which is what Vercel injects', () => {
    process.env.BLOB_STORE_ID = 'store_62RZPxPOACt2L27D';
    assert.equal(hasBlobCredentials(), true);
    assert.equal(getStorage().kind, 'blob');
  });

  test('accepts an explicit read-write token, used outside Vercel', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_example';
    assert.equal(hasBlobCredentials(), true);
    assert.equal(getStorage().kind, 'blob');
  });

  test('falls back to the filesystem when developing locally', () => {
    assert.equal(hasBlobCredentials(), false);
    assert.equal(getStorage().kind, 'local');
  });

  test('refuses to pretend the filesystem works on a deployment', () => {
    process.env.VERCEL = '1';
    // A deployed function has a read-only working directory, so silently using
    // it would fail later with an opaque EROFS instead of a useful message.
    assert.throws(() => getStorage(), /No Blob store is connected/);
  });
});
