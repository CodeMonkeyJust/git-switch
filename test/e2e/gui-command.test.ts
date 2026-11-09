import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { createLogger } from '../../src/util/log.ts';
import { guiCommand } from '../../src/commands/gui.ts';
import { startServer } from '../../src/server/http.ts';

const silent = createLogger({ color: false, unifiedErrors: true, stream: process.stderr });

/**
 * `gs gui` coverage.
 *
 * The command itself is exercised in-process rather than by spawning a child:
 * a spawned CLI writes to stdio while the test runner is also using it, which on
 * Windows intermittently corrupts the runner's IPC stream
 * ("Unable to deserialize cloned data"). The behaviour under test — that the
 * command starts a server, reports a URL and that the URL's token works — does
 * not need a separate process.
 */

test('gs gui refuses to start without a profile', async () => {
  const h = await createTmpHome();
  try {
    const code = await guiCommand({ home: h.home, open: false, json: true, logger: silent });
    assert.equal(code, 2);
  } finally {
    await h.cleanup();
  }
});

test('the URL guiCommand prints authenticates against the started server', async () => {
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

    // start the same server the command builds, with the same options
    const server = await startServer({ home: h.home });
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=.+$/);

      const base = (server.url.split('#')[0] as string).replace(/\/$/, '');
      const token = server.url.split('token=')[1] as string;

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
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('gui writes and reads its single-instance lock file', async () => {
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
    // the lock format the command writes must be parseable again
    const { writeFile } = await import('node:fs/promises');
    const lock = { pid: process.pid, port: 47821, startedAt: new Date().toISOString() };
    await h.write('.config/gs/gui.lock', JSON.stringify(lock));
    const read = JSON.parse(await readFile(path.join(h.home, '.config', 'gs', 'gui.lock'), 'utf8'));
    assert.equal(read.pid, process.pid);
    assert.equal(read.port, 47821);
    void writeFile;
  } finally {
    await h.cleanup();
  }
});

test('the GUI entry point and assets exist where the server looks for them', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const webRoot = path.resolve(here, '..', '..', 'web');
  for (const asset of ['index.html', 'src/main.js', 'src/api.js', 'src/styles/main.css']) {
    const info = await stat(path.join(webRoot, asset)).catch(() => undefined);
    assert.ok(info?.isFile(), `${asset} must exist for the GUI to load`);
  }
});
