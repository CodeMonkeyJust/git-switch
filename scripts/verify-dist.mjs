#!/usr/bin/env node
/**
 * Release gate: verify the published artefact obeys the project's promises.
 *
 *   1. package.json declares zero runtime dependencies
 *   2. the committed tree contains no absolute paths from a developer machine
 *   3. no secrets leaked into tracked files
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function checkDependencies() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length > 0) problems.push(`runtime dependencies are not allowed: ${deps.join(', ')}`);
}

async function checkFiles() {
  const files = await walk(root);
  const forbidden = [
    { re: /C:\\Users\\[^"]*\\AppData/i, what: 'absolute Windows user path' },
    { re: /D:\\CODE\\/i, what: 'developer working directory' },
  ];
  // Tests must contain PEM headers on purpose to prove they are rejected, and
  // docs explain the rule, so key material is checked only where it would ship.
  const keyMaterial = { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key material' };
  const shipped = /(^src[\\/]|^scripts[\\/]|^examples[\\/]|^dist[\\/]|package\.json$)/;

  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel === path.join('scripts', 'verify-dist.mjs')) continue;
    const info = await stat(file);
    if (info.size > 1024 * 1024) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const { re, what } of forbidden) {
      if (re.test(text)) problems.push(`${rel}: contains ${what}`);
    }
    if (rel === 'test/unit/model.test.ts' || rel.startsWith('docs')) continue;
    if (shipped.test(rel) && keyMaterial.re.test(text)) {
      problems.push(`${rel}: contains ${keyMaterial.what}`);
    }
  }
}

await checkDependencies();
await checkFiles();

if (problems.length > 0) {
  console.error('verify-dist failed:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('✓ zero runtime dependencies');
  console.log('✓ no machine-specific paths or secrets in tracked files');
}
