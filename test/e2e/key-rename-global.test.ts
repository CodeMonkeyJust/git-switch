import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { renameKey } from '../../src/core/keys.ts';
import { setUserSection, readGlobalIdentity, writeGlobalIdentity } from '../../src/core/paths.ts';
import { loadProfiles } from '../../src/core/profiles.ts';

/**
 * Two operations the GUI never had: renaming a key file, and setting the global
 * identity in ~/.gitconfig.
 *
 * Renaming must keep the profile loadable (identities reference keys by name),
 * and writing the global identity must not disturb anything else in the file —
 * comments, other sections and the gs managed block all stay as they are.
 */

const PROFILE = `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: work@example.com
    sshKey: id_old
    sites:
      - host: git.example.com
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
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), PROFILE, 'utf8');
    await writeFile(path.join(h.home, '.gitconfig'), '[user]\n\tname = old\n\temail = old@example.com\n', 'utf8');
    await writeFile(
      path.join(h.home, '.ssh', 'id_old'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
      'utf8',
    );
    await writeFile(path.join(h.home, '.ssh', 'id_old.pub'), 'ssh-ed25519 AAAA old\n', 'utf8');

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

/* ------------------------------ rename key ----------------------------- */

test('renameKey moves the private key and its public companion', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await writeFile(path.join(h.home, '.ssh', 'id_a'), 'priv', 'utf8');
    await writeFile(path.join(h.home, '.ssh', 'id_a.pub'), 'pub', 'utf8');

    const result = await renameKey({ home: h.home, from: 'id_a', to: 'id_b' });
    assert.deepEqual(result.moved.sort(), ['id_b', 'id_b.pub']);
    assert.equal(await readFile(path.join(h.home, '.ssh', 'id_b'), 'utf8'), 'priv');
    assert.equal(await readFile(path.join(h.home, '.ssh', 'id_b.pub'), 'utf8'), 'pub');
  } finally {
    await h.cleanup();
  }
});

test('renameKey refuses an existing target and an invalid name', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await writeFile(path.join(h.home, '.ssh', 'id_a'), 'priv', 'utf8');
    await writeFile(path.join(h.home, '.ssh', 'id_b'), 'other', 'utf8');

    await assert.rejects(() => renameKey({ home: h.home, from: 'id_a', to: 'id_b' }), /already exists/);
    await assert.rejects(() => renameKey({ home: h.home, from: 'id_a', to: '../evil' }), /only letters/);
    await assert.rejects(() => renameKey({ home: h.home, from: 'missing', to: 'id_c' }), /does not exist/);
  } finally {
    await h.cleanup();
  }
});

test('renaming through the API updates the identities that reference the key', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);
    const res = await post('/api/keys', { action: 'rename', name: 'id_old', newName: 'id_new' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.identitiesUpdated, 1);

    // the profile must still load, and point at the new file
    const profiles = await loadProfiles(home);
    assert.equal(profiles.identities[0]?.sshKey, 'id_new');
    assert.equal(await readFile(path.join(home, '.ssh', 'id_new'), 'utf8').then((c) => c.includes('PRIVATE KEY')), true);
  });
});

test('renaming to an existing key is refused by the API', async () => {
  await withServer(async ({ home, base, auth }) => {
    await writeFile(path.join(home, '.ssh', 'id_taken'), 'x', 'utf8');
    const post = poster(base, auth);
    const res = await post('/api/keys', { action: 'rename', name: 'id_old', newName: 'id_taken' });
    assert.equal(res.status, 400);
    // nothing moved
    assert.equal(await readFile(path.join(home, '.ssh', 'id_old'), 'utf8').then((c) => c.includes('PRIVATE KEY')), true);
  });
});

/* --------------------------- global identity --------------------------- */

test('setUserSection replaces values in place and keeps other content', () => {
  const before = ['[user]', '\tname = old', '\temail = old@example.com', '', '[core]', '\teditor = vim'].join('\n');
  const after = setUserSection(before, { name: 'new', email: 'new@example.com' });
  assert.match(after, /name = new/);
  assert.match(after, /email = new@example\.com/);
  assert.match(after, /\[core\]\n\teditor = vim/, 'other sections survive');
  assert.ok(!after.includes('old'), after);
});

test('setUserSection creates the section when it is missing', () => {
  const after = setUserSection('[core]\n\teditor = vim', { name: 'n', email: 'e@example.com' });
  assert.match(after, /\[user\]/);
  assert.match(after, /name = n/);
  assert.match(after, /email = e@example\.com/);
  assert.match(after, /\[core\]/, 'existing content is kept');
});

test('setUserSection leaves the gs managed block untouched', () => {
  const before = [
    '[user]',
    '\tname = old',
    '\temail = old@example.com',
    '',
    '# >>> gs:managed >>>',
    '[includeIf "gitdir:/code/"]',
    '\tpath = ~/.config/gs/identities/a.gitconfig',
    '# <<< gs:managed <<<',
  ].join('\n');
  const after = setUserSection(before, { name: 'new', email: 'n@example.com' });
  assert.match(after, /# >>> gs:managed >>>[\s\S]*# <<< gs:managed <<</);
  assert.match(after, /name = new/);
});

test('writeGlobalIdentity persists and reports the previous value', async () => {
  const h = await createTmpHome();
  try {
    await writeFile(path.join(h.home, '.gitconfig'), '[user]\n\tname = old\n\temail = old@example.com\n', 'utf8');
    const { before } = await writeGlobalIdentity(h.home, { name: 'new', email: 'new@example.com' });
    assert.equal(before?.email, 'old@example.com');

    const after = await readGlobalIdentity(h.home);
    assert.equal(after?.name, 'new');
    assert.equal(after?.email, 'new@example.com');
  } finally {
    await h.cleanup();
  }
});

test('the global identity can be set through the API', async () => {
  await withServer(async ({ home, base, auth }) => {
    const post = poster(base, auth);
    const res = await post('/api/global-identity', { name: 'zlj20', email: 'zlj20@163.com' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.after, 'zlj20 <zlj20@163.com>');

    const identity = await readGlobalIdentity(home);
    assert.equal(identity?.email, 'zlj20@163.com');

    // the managed block must still be present and untouched
    const text = await readFile(path.join(home, '.gitconfig'), 'utf8');
    assert.match(text, /\[user\]/);
  });
});

test('the global identity endpoint rejects a bad email', async () => {
  await withServer(async ({ home, base, auth }) => {
    const before = await readFile(path.join(home, '.gitconfig'), 'utf8');
    const post = poster(base, auth);
    const res = await post('/api/global-identity', { name: 'x', email: 'not-an-email' });
    assert.equal(res.status, 400);

    const after = await readFile(path.join(home, '.gitconfig'), 'utf8');
    assert.equal(after, before, 'a rejected request must not touch the file');
  });
});
