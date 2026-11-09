import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { generateKey } from '../../src/core/keys.ts';
import { loadProfiles } from '../../src/core/profiles.ts';

/**
 * Feature parity between the CLI and the GUI.
 *
 * Every CLI capability must be reachable over the API the browser uses:
 * `key list|gen|copy|restore`, `snapshot export|import`, `init`, and `--lang`.
 */

const PROFILE = `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@example.com
    sshKey: id_work
    sites:
      - host: git.example.com
        port: 9092
        alias: pde
rules:
  - dir: /code/work
    identity: work
`;

async function withServer(
  fn: (ctx: { home: string; server: RunningServer; base: string; auth: Record<string, string> }) => Promise<void>,
) {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
    await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), PROFILE, 'utf8');
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');
    await generateKey({ home: h.home, name: 'id_work' });

    const server = await startServer({ home: h.home });
    try {
      await fn({
        home: h.home,
        server,
        base: `http://127.0.0.1:${server.port}`,
        auth: { 'x-gs-token': server.token },
      });
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

function poster(base: string, auth: Record<string, string>) {
  return async (p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  };
}

/* -------------------------------- keys -------------------------------- */

test('GET /api/keys lists keys without any key material', async () => {
  await withServer(async ({ base, auth }) => {
    const res = await fetch(`${base}/api/keys`, { headers: auth });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('PRIVATE KEY'), 'the API must never return private key material');

    const body = JSON.parse(text) as { keys: { name: string; fingerprint: string; usedBy: string[] }[] };
    const key = body.keys.find((k) => k.name === 'id_work');
    assert.ok(key, 'the generated key is listed');
    assert.match(key.fingerprint ?? '', /^SHA256:/);
    assert.deepEqual(key.usedBy, ['work']);
  });
});

test('POST /api/keys generate creates a key and refuses a duplicate', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);

    const created = await post('/api/keys', { action: 'generate', name: 'id_extra', comment: 'x@example.com' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const content = await readFile(path.join(home, '.ssh', 'id_extra'), 'utf8');
    assert.match(content, /PRIVATE KEY/);

    const duplicate = await post('/api/keys', { action: 'generate', name: 'id_extra' });
    assert.equal(duplicate.status, 400, 'generating over an existing key must fail');
  });
});

test('POST /api/keys copy returns the public key when no clipboard is available', async () => {
  await withServer(async ({ base, auth }) => {
    const post = poster(base, auth);
    const res = await post('/api/keys', { action: 'copy', name: 'id_work' });
    assert.equal(res.status, 200);
    assert.ok(
      res.body.copied === true || typeof res.body.publicKey === 'string',
      'either the clipboard worked or the key is returned',
    );
  });
});

/* ------------------------------ snapshots ----------------------------- */

test('a snapshot exported through the API is encrypted and can be imported', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);
    const target = path.join(home, 'parity.gsnap');

    const exported = await post('/api/snapshot/export', {
      path: target,
      withKeys: true,
      passphrase: 'long-enough-passphrase',
    });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));

    const sealed = await readFile(target, 'utf8');
    assert.ok(sealed.includes('"magic"'), 'the archive is encrypted');
    assert.ok(!sealed.includes('PRIVATE KEY'), 'no plaintext key on disk');

    const imported = await post('/api/snapshot/import', {
      path: target,
      passphrase: 'long-enough-passphrase',
      remaps: '/code/work=/srv/work',
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));

    const migrated = await loadProfiles(home);
    assert.ok(migrated.rules.some((r) => r.dir === '/srv/work'), 'the remap reached the profile');
  });
});

test('exporting with keys but no passphrase is refused', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);
    const res = await post('/api/snapshot/export', {
      path: path.join(home, 'nokey.gsnap'),
      withKeys: true,
      passphrase: '',
    });
    assert.equal(res.status, 400);
  });
});

test('importing with the wrong passphrase fails without touching the profile', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);
    const target = path.join(home, 'sealed.gsnap');
    await post('/api/snapshot/export', { path: target, withKeys: true, passphrase: 'correct-passphrase' });

    const before = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    const res = await post('/api/snapshot/import', { path: target, passphrase: 'wrong-passphrase' });
    assert.equal(res.status, 400);

    const after = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(after, before, 'a failed import must not modify the profile');
  });
});

/* -------------------------------- init -------------------------------- */

test('init scan reports what it would write, and apply refuses an existing profile', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);

    const scan = await post('/api/init/scan', { root: home, offline: true });
    assert.equal(scan.status, 200);
    const body = scan.body as { identities: unknown[]; rules: unknown[] };
    assert.ok(Array.isArray(body.identities));
    assert.ok(Array.isArray(body.rules));

    // scanning must not write anything
    const profile = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.equal(profile, PROFILE, 'scanning is read-only');

    const blocked = await post('/api/init/apply', { root: home, offline: true });
    assert.equal(blocked.status, 409, 'an existing profile is protected');
  });
});

test('init apply writes a profile when none exists', async () => {
  const h = await createTmpHome();
  try {
    await writeFile(path.join(h.home, '.gitconfig'), '[user]\n\tname = u\n\temail = u@example.com\n', 'utf8');
    await mkdir(path.join(h.home, 'code', 'repo'), { recursive: true });

    const server = await startServer({ home: h.home });
    const base = `http://127.0.0.1:${server.port}`;
    const post = poster(base, { 'x-gs-token': server.token });
    try {
      const res = await post('/api/init/apply', { root: path.join(h.home, 'code'), offline: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const profiles = await loadProfiles(h.home);
      assert.ok(profiles.identities.length >= 1, 'a profile was created');
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------- language ----------------------------- */

test('state switches the language and ships the matching catalogue', async () => {
  await withServer(async ({ base, auth }) => {
    const zhRes = await fetch(`${base}/api/state?lang=zh-CN`, { headers: auth });
    const zh = (await zhRes.json()) as { language: string; messages: Record<string, string> };
    assert.equal(zh.language, 'zh-CN');
    assert.equal(zh.messages['web.tab.keys'], '密钥');

    const enRes = await fetch(`${base}/api/state?lang=en`, { headers: auth });
    const en = (await enRes.json()) as { language: string; messages: Record<string, string> };
    assert.equal(en.language, 'en');
    assert.equal(en.messages['web.tab.keys'], 'Keys');
  });
});

test('every API endpoint rejects a request without a token', async () => {
  await withServer(async ({ base }) => {
    const endpoints = ['/api/keys', '/api/state', '/api/doctor', '/api/fs'];
    for (const endpoint of endpoints) {
      const res = await fetch(`${base}${endpoint}`);
      assert.equal(res.status, 401, `${endpoint} must require a token`);
    }

    for (const endpoint of ['/api/snapshot/export', '/api/snapshot/import', '/api/init/scan']) {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 401, `${endpoint} must require a token`);
    }
  });
});
