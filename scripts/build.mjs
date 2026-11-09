#!/usr/bin/env node
/**
 * Build the published artefact.
 *
 * Node refuses to strip types for files inside node_modules
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so shipping `.ts` sources and
 * relying on runtime stripping works from a checkout but crashes for anyone who
 * installs the package. The build therefore emits real JavaScript:
 *
 *   tsc -p tsconfig.build.json   src/**\/*.ts -> dist/**\/*.js
 *   copy web/                    -> dist/web    (assets for `gs gui`)
 *   write dist/gs.mjs            (launcher; package `bin` points here)
 *
 * TypeScript is a devDependency only: the published package still has zero
 * runtime dependencies.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // 1. compile the engine to plain JavaScript
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    // tsc missing (fresh clone without devDependencies): fall back to Node's
    // stripper, which is enough for running from a checkout but NOT for publish.
    console.warn('tsc unavailable — falling back to source copy (not publishable)');
    await cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
    const fallback = `#!/usr/bin/env node
import { main } from './src/cli.ts';
main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 2; });
`;
    await writeFile(path.join(dist, 'gs.mjs'), fallback, 'utf8');
    await cp(path.join(root, 'web'), path.join(dist, 'web'), { recursive: true });
    return;
  }

  // 2. verify the compiler actually produced the entry point
  const cli = await stat(path.join(dist, 'cli.js')).catch(() => undefined);
  if (!cli) throw new Error('tsc produced no dist/cli.js');

  // 3. static assets for the GUI
  await cp(path.join(root, 'web'), path.join(dist, 'web'), { recursive: true });

  // 4. launcher
  const launcher = `#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    if (err instanceof Error && err.name === 'ProfilesMissingError') {
      console.error('✗ ' + err.message);
    } else {
      console.error('✗ ' + (err instanceof Error ? err.message : String(err)));
    }
    process.exitCode = 2;
  });
`;
  await writeFile(path.join(dist, 'gs.mjs'), launcher, 'utf8');

  const emitted = await stat(path.join(dist, 'web', 'index.html')).catch(() => undefined);
  if (!emitted) throw new Error('dist/web/index.html is missing');

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  console.log(`built ${pkg.name}@${pkg.version} -> dist/`);
  console.log('  dist/gs.mjs   entry point (ESM)');
  console.log('  dist/*.js     engine as plain JavaScript');
  console.log('  dist/web/**   GUI assets');
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exitCode = 1;
});
