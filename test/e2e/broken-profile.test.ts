import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer } from '../../src/server/http.ts';

/**
 * A single invalid field must not blank the whole UI.
 *
 * Pasting a URL (`http://git.example.com:9090/`) into a site's host field used to
 * make /api/state throw, the endpoint answered 400, and every screen rendered
 * empty with no explanation. The state endpoint now degrades: it returns empty
 * data *plus* the reason, so the page can show what is wrong and where to fix it.
 */

const BROKEN_HOST = `schemaVersion: 1
identities:
  pdegit:
    user:
      name: zhulj
      email: zhulj@example.com
    sshKey: id_key
    sites:
      - host: http://git.pdesoft.cn:9090/
rules: []
`;

const VALID = `schemaVersion: 1
identities:
  ok:
    user:
      name: zhulj
      email: zhulj@example.com
rules: []
`;

async function withServer(profile: string, fn: (base: string, token: string, home: string) => Promise<void>) {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
    await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), profile, 'utf8');
    await writeFile(path.join(h.home, '.gitconfig'), '[user]\n\tname = g\n\temail = g@example.com\n', 'utf8');
    const server = await startServer({ home: h.home });
    try {
      await fn(`http://127.0.0.1:${server.port}`, server.token, h.home);
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

test('a broken profile still yields a usable state response', async () => {
  await withServer(BROKEN_HOST, async (base, token) => {
    const res = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } });
    assert.equal(res.status, 200, 'the UI must still be able to load');

    const state = (await res.json()) as {
      profileError?: string;
      identities: unknown[];
      rules: unknown[];
      messages: Record<string, string>;
      homePath: string;
    };

    assert.ok(state.profileError, 'the reason is reported');
    assert.match(state.profileError, /not a valid host|invalid host/i, state.profileError);

    // everything the shell needs to render is still present
    assert.deepEqual(state.identities, []);
    assert.deepEqual(state.rules, []);
    assert.ok(Object.keys(state.messages).length > 0, 'the catalogue is still sent');
    assert.ok(state.homePath, 'the home is still reported');
  });
});

test('a broken profile does not hide which home is in use', async () => {
  await withServer(BROKEN_HOST, async (base, token) => {
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })
    ).json()) as { isSandbox: boolean; realHome: string };
    assert.equal(state.isSandbox, true, 'a --home instance is still flagged');
    assert.ok(state.realHome);
  });
});

test('every other screen endpoint reports the error instead of crashing', async () => {
  await withServer(BROKEN_HOST, async (base, token) => {
    const auth = { 'x-gs-token': token, 'content-type': 'application/json' };

    // plan and doctor return a 4xx with a message; neither may hang or 500
    for (const [endpoint, init] of [
      ['/api/plan', { method: 'POST', headers: auth, body: '{}' }],
      ['/api/doctor', { method: 'GET', headers: auth }],
      ['/api/keys', { method: 'GET', headers: auth }],
    ] as [string, RequestInit][]) {
      const res = await fetch(`${base}${endpoint}`, init);
      assert.ok(res.status < 500, `${endpoint} returned ${res.status}`);
      const body = (await res.json()) as { error?: string };
      if (res.status >= 400) {
        assert.ok(body.error, `${endpoint} must explain the failure`);
      }
    }
  });
});

test('fixing the profile restores a normal state response', async () => {
  await withServer(VALID, async (base, token) => {
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })
    ).json()) as { profileError?: string; identities: { name: string }[] };
    assert.equal(state.profileError, undefined);
    assert.equal(state.identities.length, 1);
    assert.equal(state.identities[0]?.name, 'ok');
  });
});

test('the error names the field so the user can find it', async () => {
  await withServer(BROKEN_HOST, async (base, token) => {
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })
    ).json()) as { profileError?: string };
    assert.match(state.profileError ?? '', /sites\[0\]\.host|identities\.pdegit/);
  });
});
