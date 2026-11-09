import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { keysFromSnapshot, restoreKeys } from '../../src/core/key-restore.ts';
import { buildSnapshot, encryptSnapshot, decryptSnapshot } from '../../src/core/snapshot.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { generateKey } from '../../src/core/keys.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

/**
 * `snapshot export --with-keys` embeds key material, but import deliberately
 * leaves ~/.ssh alone. Without a restore path the option would be a one-way
 * trip; these tests cover the loop being closed.
 */

test('keysFromSnapshot picks up private and public keys only', () => {
  const keys = keysFromSnapshot({
    files: [
      { path: 'profiles.yaml', content: 'x' },
      { path: 'keys/id_ed25519', content: 'PRIVATE' },
      { path: 'keys/id_ed25519.pub', content: 'PUBLIC' },
      { path: 'keys/nested/evil', content: 'NOPE' },
      { path: 'keys/../../etc/passwd', content: 'NOPE' },
      { path: 'identities/a.gitconfig', content: 'x' },
    ],
  });
  assert.deepEqual(
    keys.map((k) => k.name).sort(),
    ['id_ed25519', 'id_ed25519.pub'],
    'only flat keys/ entries are accepted',
  );
});

test('restoreKeys writes keys with restrictive permissions', async () => {
  const h = await createTmpHome();
  try {
    const result = await restoreKeys({
      home: h.home,
      keys: [
        { name: 'id_priv', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n', isPublic: false },
        { name: 'id_priv.pub', content: 'ssh-ed25519 AAAA\n', isPublic: true },
      ],
    });
    assert.deepEqual(result.written.sort(), ['id_priv', 'id_priv.pub']);
    assert.equal(await h.read('.ssh/id_priv'), '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');

    if (process.platform !== 'win32') {
      const info = await stat(path.join(h.home, '.ssh', 'id_priv'));
      assert.equal(info.mode & 0o777, 0o600, 'private keys must be 0600');
    }
  } finally {
    await h.cleanup();
  }
});

test('restoreKeys refuses to overwrite without force', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_exist', 'original');
    const result = await restoreKeys({
      home: h.home,
      keys: [{ name: 'id_exist', content: 'replacement', isPublic: false }],
    });
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, ['id_exist']);
    assert.equal(await h.read('.ssh/id_exist'), 'original');
  } finally {
    await h.cleanup();
  }
});

test('restoreKeys overwrites with force', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_exist', 'original');
    const result = await restoreKeys({
      home: h.home,
      keys: [{ name: 'id_exist', content: 'replacement', isPublic: false }],
      force: true,
    });
    assert.deepEqual(result.written, ['id_exist']);
    assert.equal(await h.read('.ssh/id_exist'), 'replacement');
  } finally {
    await h.cleanup();
  }
});

test('a key survives the full export -> encrypt -> decrypt -> restore loop', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  try {
    const created = await generateKey({ home: source.home, name: 'id_roundtrip' });
    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  a:
    user:
      name: u
      email: u@example.com
    sshKey: id_roundtrip
rules: []
`,
      source.home,
    );

    const snapshot = await buildSnapshot({ home: source.home, profiles, includeKeys: true });
    const sealed = await encryptSnapshot(snapshot, 'a-long-enough-passphrase');
    assert.ok(!sealed.includes('OPENSSH PRIVATE KEY'), 'the sealed form holds no plaintext key');

    const opened = await decryptSnapshot(sealed, 'a-long-enough-passphrase');
    const keys = keysFromSnapshot(opened);
    assert.ok(keys.length >= 1);

    const result = await restoreKeys({ home: target.home, keys });
    assert.ok(result.written.includes('id_roundtrip'));

    const restored = await readFile(path.join(target.home, '.ssh', 'id_roundtrip'), 'utf8');
    const original = await readFile(path.join(source.home, '.ssh', 'id_roundtrip'), 'utf8');
    assert.equal(restored, original, 'the restored key is byte-identical');
    assert.equal(restored, created.publicKey.replace(/^.*$/, restored.trim() + '\n').trim() + '\n');
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('a snapshot without keys yields an empty list', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');
    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  a:
    user:
      name: u
      email: u@example.com
rules: []
`,
      h.home,
    );
    const snapshot = await buildSnapshot({ home: h.home, profiles });
    assert.deepEqual(keysFromSnapshot(snapshot), []);
  } finally {
    await h.cleanup();
  }
});
