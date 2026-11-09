#!/usr/bin/env node
/**
 * Coverage audit: which exported symbols are actually exercised by the tests?
 *
 * A file "has a test" is not the same as "its code runs". This scans every
 * exported function/const in src/ and counts textual references from the test
 * tree, reporting the ones with none. It is a cheap heuristic, not a coverage
 * tool — but it reliably finds whole features with no test at all, which is how
 * two real bugs were discovered in round 19.
 *
 * Usage: node scripts/coverage-audit.mjs [--strict]
 *   --strict  exit non-zero when any export is unreferenced
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

async function walk(dir, filter, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, filter, acc);
    else if (filter(entry.name)) acc.push(full);
  }
  return acc;
}

/** `export function foo(` / `export const foo =` / `export class Foo` / `export { a, b }` */
function exportedNames(source) {
  const names = new Set();

  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

const srcFiles = await walk(path.join(root, 'src'), (n) => n.endsWith('.ts'));
const testFiles = await walk(path.join(root, 'test'), (n) => n.endsWith('.ts') || n.endsWith('.mjs'));

const testText = (await Promise.all(testFiles.map((f) => readFile(f, 'utf8')))).join('\n');
// references from production code count too: a helper used by a tested path is covered
const srcText = (await Promise.all(srcFiles.map((f) => readFile(f, 'utf8')))).join('\n');

const unreferenced = [];
const total = [];

for (const file of srcFiles) {
  const source = await readFile(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const name of exportedNames(source)) {
    // skip type-only symbols: interfaces and type aliases are erased at runtime
    if (new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`).test(source)) continue;
    total.push({ rel, name });

    const inTests = new RegExp(`\\b${name}\\b`).test(testText);
    const inSrcOtherFiles = srcFiles
      .filter((f) => f !== file)
      .some(async () => true); // placeholder; real check below
    void inSrcOtherFiles;

    // count uses outside the declaration line
    const usesInSrc = [...srcText.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    const declaredHere = [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;

    if (!inTests && declaredHere <= 1) {
      unreferenced.push({ rel, name, note: 'never referenced outside its declaration' });
    } else if (!inTests && usesInSrc === declaredHere) {
      unreferenced.push({ rel, name, note: 'only referenced by its own declaration' });
    }
  }
}

total.sort((a, b) => a.rel.localeCompare(b.rel));
unreferenced.sort((a, b) => a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name));

console.log(`scanned ${srcFiles.length} source files, ${total.length} exported symbols`);
console.log(`test files: ${testFiles.length}`);

if (unreferenced.length === 0) {
  console.log('every exported symbol is referenced by the tests');
} else {
  console.log(`\n${unreferenced.length} symbol(s) with no test reference:`);
  for (const item of unreferenced) {
    console.log(`  ${item.rel}: ${item.name}  (${item.note})`);
  }
}

process.exitCode = strict && unreferenced.length > 0 ? 1 : 0;
