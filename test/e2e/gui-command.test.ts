import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { createLogger } from '../../src/util/log.ts';
import { guiCommand } from '../../src/commands/gui.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const posix = (p: string) => p.replace(/\\/g, '/');

const silent = createLogger({ color: false, unifiedErrors: true });

test('gs gui refuses to start without a profile', async () => {
  const h = await createTmpHome();
  try {
    const code = await guiCommand({ home: h.home, open: false, json: true, logger: silent });
    assert.equal(code, 2);
  } finally {
    await h.cleanup();
  }
});

test('gs gui serves a working UI reachable with the printed token', async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      '.config/gs/profiles.yaml',
      `schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: a@example.com
rules: []
`,
    );

    // run the real command in a child process so we can watch it start and stop it
    const cliPath = posix(path.join(repoRoot, 'src', 'cli.ts'));
    const child = spawn(
      process.execPath,
      [cliPath, 'gui', '--home', h.home, '--no-open', '--json', '--idle-timeout', '0'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const output = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`gs gui did not report a URL in time; output=${buffer}`));
      }, 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('"url"')) {
          clearTimeout(timer);
          resolve(buffer);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!buffer.includes('"url"')) reject(new Error(`gs gui exited (${code}): ${buffer}`));
      });
    });

    const match = /"url":\s*"([^"]+)"/.exec(output);
    assert.ok(match, `no url in output: ${output}`);
    const url = match[1] as string;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#token=.+$/);

    const base = (url.split('#')[0] as string).replace(/\/$/, '');
    const token = url.split('token=')[1] as string;

    try {
      const page = await fetch(`${base}/`, { headers: { 'x-gs-token': token } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /data-view="overview"/);
      assert.match(html, /data-view="preview"/);

      const state = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } });
      assert.equal(state.status, 200);
      const body = (await state.json()) as { identities: unknown[] };
      assert.equal(body.identities.length, 1);

      // without the token the same server must refuse
      const denied = await fetch(`${base}/api/state`);
      assert.equal(denied.status, 401);

      const lock = JSON.parse(await h.read('.config/gs/gui.lock')) as { pid: number; port: number };
      assert.ok(lock.pid > 0);
      assert.equal(lock.port, Number.parseInt(new URL(base).port, 10));
    } finally {
      child.kill();
    }
  } finally {
    await h.cleanup();
  }
});
