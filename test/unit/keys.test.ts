import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { generateKey, listKeys, listPrivateKeys, publicKeyFor, keyFingerprint } from '../../src/core/keys.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

test('generateKey creates a usable ed25519 pair', async () => {
  const h = await createTmpHome();
  try {
    const result = await generateKey({ home: h.home, name: 'id_test', comment: 'me@example.com' });
    assert.ok(result.publicKey.startsWith('ssh-ed25519 '), result.publicKey);
    assert.ok(result.fingerprint, 'a fingerprint is reported');
    assert.match(result.fingerprint ?? '', /^SHA256:/);
    assert.ok(await h.exists('.ssh/id_test'));
    assert.ok(await h.exists('.ssh/id_test.pub'));
  } finally {
    await h.cleanup();
  }
});

test('generateKey refuses to overwrite an existing key', async () => {
  const h = await createTmpHome();
  try {
    await generateKey({ home: h.home, name: 'id_dup' });
    await assert.rejects(() => generateKey({ home: h.home, name: 'id_dup' }), /already exists/);
  } finally {
    await h.cleanup();
  }
});

test('generateKey rejects path-traversal style names', async () => {
  const h = await createTmpHome();
  try {
    await assert.rejects(() => generateKey({ home: h.home, name: '../evil' }), /invalid key name/);
    await assert.rejects(() => generateKey({ home: h.home, name: 'a/b' }), /invalid key name/);
  } finally {
    await h.cleanup();
  }
});

test('listPrivateKeys finds keys and ignores pub/config/known_hosts', async () => {
  const h = await createTmpHome();
  try {
    await generateKey({ home: h.home, name: 'id_one' });
    await h.write('.ssh/config', 'Host x\n');
    await h.write('.ssh/known_hosts', 'entry');
    await h.write('.ssh/notes.txt', 'not a key');

    const names = await listPrivateKeys(h.home);
    assert.deepEqual(names, ['id_one']);
  } finally {
    await h.cleanup();
  }
});

test('listKeys attributes a key to the identities that use it', async () => {
  const h = await createTmpHome();
  try {
    await generateKey({ home: h.home, name: 'id_work' });
    await generateKey({ home: h.home, name: 'id_unused' });

    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: a@example.com
    sshKey: id_work
rules: []
`,
      h.home,
    );

    const keys = await listKeys({ home: h.home, profiles });
    const work = keys.find((k) => k.name === 'id_work');
    const unused = keys.find((k) => k.name === 'id_unused');
    assert.deepEqual(work?.usedBy, ['work']);
    assert.deepEqual(unused?.usedBy, []);
    assert.ok(work?.fingerprint?.startsWith('SHA256:'));
  } finally {
    await h.cleanup();
  }
});

test('publicKeyFor returns the .pub contents', async () => {
  const h = await createTmpHome();
  try {
    const created = await generateKey({ home: h.home, name: 'id_pub' });
    const pub = await publicKeyFor(h.home, 'id_pub');
    assert.equal(pub, created.publicKey);
  } finally {
    await h.cleanup();
  }
});

test('publicKeyFor rejects a missing key', async () => {
  const h = await createTmpHome();
  try {
    await assert.rejects(() => publicKeyFor(h.home, 'id_missing'), /does not exist/);
  } finally {
    await h.cleanup();
  }
});

test('keyFingerprint on a non-key file returns no fingerprint', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/junk', 'hello');
    const info = await keyFingerprint(posix(`${h.home}/.ssh/junk`));
    assert.equal(info.fingerprint, undefined);
  } finally {
    await h.cleanup();
  }
});
