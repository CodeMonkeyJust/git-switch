import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpHome } from '../helpers/tmp-home.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');
const posix = (p: string) => p.replace(/\\/g, '/');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A profile whose rules live under Windows-style paths, to exercise remapping. */
async function seedProfile(home: string): Promise<void> {
  const yaml = [
    'schemaVersion: 1',
    'identities:',
    '  w:',
    '    user:',
    '      name: w',
    '      email: w@example.com',
    'rules:',
    '  - dir: D:/CODE/company',
    '    identity: w',
    '  - dir: D:/CODE/github',
    '    identity: w',
    '  - dir: D:/CODE/gitee',
    '    identity: w',
    '',
  ].join('\n');
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await mkdir(path.join(home, 'placeholder'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(home, '.config', 'gs', 'profiles.yaml'), yaml, 'utf8');
}

test('multiple --remap flags are all applied, not just the last one', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snapshot = path.join(source.home, 'snap.gsnap');

  try {
    await seedProfile(source.home);

    const exported = await runCli(['snapshot', 'export', snapshot, '--home', source.home, '--force', '--no-color']);
    assert.equal(exported.code, 0, exported.stderr);

    const imported = await runCli([
      'snapshot', 'import', snapshot,
      '--home', target.home,
      '--remap', 'D:/CODE/company=/opt/pde',
      '--remap', 'D:/CODE/github=/opt/gh',
      '--remap', 'D:/CODE/gitee=/opt/gitee',
      '--no-color',
    ]);
    assert.equal(imported.code, 0, imported.stderr);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path.join(target.home, '.config', 'gs', 'profiles.yaml'), 'utf8');

    assert.match(written, /- dir: \/opt\/pde/);
    assert.match(written, /- dir: \/opt\/gh/);
    assert.match(written, /- dir: \/opt\/gitee/);
    assert.ok(!written.includes('D:/CODE'), `no original path should remain:\n${written}`);
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('a single --remap still works', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snapshot = path.join(source.home, 'snap.gsnap');
  try {
    await seedProfile(source.home);
    await runCli(['snapshot', 'export', snapshot, '--home', source.home, '--force', '--no-color']);

    const imported = await runCli([
      'snapshot', 'import', snapshot,
      '--home', target.home,
      '--remap', 'D:/CODE=/home/dev/code',
      '--no-color',
    ]);
    assert.equal(imported.code, 0, imported.stderr);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path.join(target.home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.match(written, /- dir: \/home\/dev\/code\/company/);
    assert.match(written, /- dir: \/home\/dev\/code\/github/);
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('--remap=<spec> with an equals sign inside the value is parsed once', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snapshot = path.join(source.home, 'snap.gsnap');
  try {
    await seedProfile(source.home);
    await runCli(['snapshot', 'export', snapshot, '--home', source.home, '--force', '--no-color']);

    const imported = await runCli([
      'snapshot', 'import', snapshot,
      '--home', target.home,
      '--remap=D:/CODE/github=/srv/gh',
      '--no-color',
    ]);
    assert.equal(imported.code, 0, imported.stderr);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(path.join(target.home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.match(written, /- dir: \/srv\/gh/);
    assert.match(written, /D:\/CODE\/company/, 'other rules stay untouched');
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('non-repeatable flags keep the last value', async () => {
  const h = await createTmpHome();
  try {
    await seedProfile(h.home);
    // --home given twice: the later one wins, so this must read the seeded profile
    const result = await runCli(['list', '--home', path.join(h.home, 'nope'), '--home', h.home, '--no-color']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /company/);
  } finally {
    await h.cleanup();
  }
});

export { posix };
