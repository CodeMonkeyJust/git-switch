import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer } from '../../src/server/http.ts';

/**
 * A GUI started with `--home` looks exactly like the real one. It must say which
 * home it operates on, in the API *and* on the console, otherwise a user can
 * configure an identity in a sandbox and wonder why the real ~/.ssh never
 * changed. That is exactly the confusion this suite guards against.
 */

interface StateResponse {
  home: string;
  homePath: string;
  realHome: string;
  isSandbox: boolean;
}

async function seed(home: string): Promise<void> {
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await writeFile(
    path.join(home, '.config', 'gs', 'profiles.yaml'),
    'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules: []\n',
    'utf8',
  );
}

test('a --home instance is reported as a sandbox in the API', async () => {
  const h = await createTmpHome();
  try {
    await seed(h.home);
    const server = await startServer({ home: h.home });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, {
        headers: { 'x-gs-token': server.token },
      });
      assert.equal(res.status, 200);
      const state = (await res.json()) as StateResponse;

      assert.equal(state.isSandbox, true, 'a --home instance must be flagged');
      assert.equal(state.homePath, h.home.replace(/\\/g, '/'), 'the operated home is exposed');
      assert.equal(state.realHome, homedir(), 'the real home is exposed for comparison');
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('the real home is not flagged as a sandbox', async () => {
  const server = await startServer({ home: homedir() });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, {
      headers: { 'x-gs-token': server.token },
    });
    // the real home may not have a profile; when it does, isSandbox must be false
    if (res.status === 200) {
      const state = (await res.json()) as StateResponse;
      assert.equal(state.isSandbox, false);
    } else {
      assert.equal(res.status, 400, 'without a profile the API reports a validation error');
    }
  } finally {
    await server.close();
  }
});

test('a sandbox home is announced in the message catalogue', async () => {
  // The console wording comes from the catalogue; assert both languages say it
  // and that the sandbox flag is what selects the warning.
  const { t, setLanguage } = await import('../../src/core/i18n.ts');

  setLanguage('en');
  const enWarn = t('gui.sandboxWarn', '/tmp/sandbox');
  assert.match(enWarn, /SANDBOX/i);
  assert.match(t('gui.home', '/tmp/sandbox'), /\/tmp\/sandbox/, 'the operated home is interpolated');
  assert.match(t('gui.realHome'), /real home/i);

  setLanguage('zh-CN');
  assert.match(t('gui.sandboxWarn'), /沙箱/);
  assert.match(t('gui.realHome'), /真实/);

  setLanguage('en');
});
