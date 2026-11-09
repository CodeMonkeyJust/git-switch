import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * These tests guard the *published* artefact, not just the checkout. A package
 * that installs but cannot serve its GUI is not "runnable" for a user.
 */

test('build output is self-contained under dist/', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'gs-build-'));
  try {
    // build into a scratch copy so the repo's dist stays untouched
    await cp(path.join(repoRoot, 'src'), path.join(work, 'src'), { recursive: true });
    await cp(path.join(repoRoot, 'web'), path.join(work, 'web'), { recursive: true });
    await cp(path.join(repoRoot, 'scripts'), path.join(work, 'scripts'), { recursive: true });
    await cp(path.join(repoRoot, 'package.json'), path.join(work, 'package.json'));

    await run(process.execPath, [path.join(work, 'scripts', 'build.mjs')]);

    for (const required of ['dist/gs.mjs', 'dist/src/cli.ts', 'dist/web/index.html']) {
      const info = await stat(path.join(work, required)).catch(() => undefined);
      assert.ok(info, `${required} must exist after build`);
      assert.ok(info.isFile(), `${required} must be a file`);
    }

    // the launcher must import the CLI relatively, so it works from any cwd
    const launcher = await readFile(path.join(work, 'dist', 'gs.mjs'), 'utf8');
    assert.match(launcher, /from '\.\/src\/cli\.ts'/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the built launcher runs from an unrelated working directory', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'gs-run-'));
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'gs-cwd-'));
  try {
    await cp(path.join(repoRoot, 'src'), path.join(work, 'src'), { recursive: true });
    await cp(path.join(repoRoot, 'web'), path.join(work, 'web'), { recursive: true });
    await cp(path.join(repoRoot, 'scripts'), path.join(work, 'scripts'), { recursive: true });
    await cp(path.join(repoRoot, 'package.json'), path.join(work, 'package.json'));
    await run(process.execPath, [path.join(work, 'scripts', 'build.mjs')]);

    const { stdout } = await run(process.execPath, [path.join(work, 'dist', 'gs.mjs'), 'version'], {
      cwd: elsewhere,
    });
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('package.json ships dist and points bin at the launcher', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
    files: string[];
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.bin.gs, 'dist/gs.mjs');
  assert.ok(pkg.files.includes('dist'), 'dist must be published');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'no runtime dependencies');
});

test('gs gui serves assets when run from the built layout', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'gs-gui-pkg-'));
  const home = await mkdtemp(path.join(tmpdir(), 'gs-gui-home-'));
  try {
    await cp(path.join(repoRoot, 'src'), path.join(work, 'src'), { recursive: true });
    await cp(path.join(repoRoot, 'web'), path.join(work, 'web'), { recursive: true });
    await cp(path.join(repoRoot, 'scripts'), path.join(work, 'scripts'), { recursive: true });
    await cp(path.join(repoRoot, 'package.json'), path.join(work, 'package.json'));
    await run(process.execPath, [path.join(work, 'scripts', 'build.mjs')]);

    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
    await writeFile(
      path.join(home, '.config', 'gs', 'profiles.yaml'),
      'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules: []\n',
      'utf8',
    );

    const child = spawn(
      process.execPath,
      [path.join(work, 'dist', 'gs.mjs'), 'gui', '--home', home, '--no-open', '--json', '--idle-timeout', '0'],
      { cwd: path.join(work, 'dist'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    const output = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`gs gui did not report a URL: ${buffer}`));
      }, 20_000);
      child.stdout.on('data', (c: Buffer) => {
        buffer += c.toString();
        if (buffer.includes('"url"')) {
          clearTimeout(timer);
          resolve(buffer);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!buffer.includes('"url"')) reject(new Error(`exit ${code}: ${buffer}`));
      });
    });

    const match = /"url":\s*"([^"]+)"/.exec(output);
    assert.ok(match, output);
    const url = match[1] as string;
    const base = (url.split('#')[0] as string).replace(/\/$/, '');
    const token = url.split('token=')[1] as string;

    try {
      for (const asset of ['/', '/src/main.js', '/src/styles/main.css']) {
        const res = await fetch(`${base}${asset}`, { headers: { 'x-gs-token': token } });
        assert.equal(res.status, 200, `${asset} must be served from the built layout`);
      }
    } finally {
      // wait for the child to actually exit, otherwise Windows keeps dist locked
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
      });
    }
  } finally {
    // give the OS a moment to release handles before removing the tree
    await new Promise((r) => setTimeout(r, 150));
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
