#!/usr/bin/env node
/**
 * Creates a local `.env` from `env.example` with a freshly generated
 * SESSION_SECRET. Safe to run repeatedly: it never overwrites an existing
 * `.env` (that would invalidate every active session and is not reversible).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, 'env.example');

if (existsSync(envPath)) {
  console.warn('.env already exists — leaving it untouched.');
  console.warn('Delete it manually first if you really want a new SESSION_SECRET.');
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error('env.example is missing. Cannot generate .env.');
  process.exit(1);
}

const secret = randomBytes(32).toString('hex');
const contents = readFileSync(examplePath, 'utf8').replace(
  /^SESSION_SECRET=.*$/m,
  `SESSION_SECRET=${secret}`,
);

writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600 });

console.log('Created .env with a fresh 64-character SESSION_SECRET.');
console.log('This file is git-ignored. Do not commit it or share it.');
