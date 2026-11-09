import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import {
  buildSnapshot,
  encryptSnapshot,
  decryptSnapshot,
  verifySnapshot,
  assertNoPlaintextKeys,
  parseRemap,
  remapPath,
  remapProfiles,
} from '../../src/core/snapshot.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

function profilesFor(home: string) {
  return parseProfilesText(
    `schemaVersion: 1
identities:
  github:
    user:
      name: z
      email: z@example.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
rules:
  - dir: ${posix(home)}/code/github
    identity: github
settings:
  backupKeep: 7
`,
    home,
  );
}

test('a snapshot never contains private keys unless asked', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_ed25519_github', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n');
    await h.write('.ssh/id_ed25519_github.pub', 'ssh-ed25519 AAAA z\n');
    const profiles = profilesFor(h.home);

    const without = await buildSnapshot({ home: h.home, profiles });
    assert.equal(without.manifest.containsKeys, false);
    assert.ok(!without.files.some((f) => f.path.startsWith('keys/')));
    const plain = JSON.stringify(without);
    assert.ok(!plain.includes('OPENSSH PRIVATE KEY'), 'no key material leaks into a keyless snapshot');

    const withKeys = await buildSnapshot({ home: h.home, profiles, includeKeys: true });
    assert.equal(withKeys.manifest.containsKeys, true);
    assert.ok(withKeys.files.some((f) => f.path === 'keys/id_ed25519_github' && f.secret));
  } finally {
    await h.cleanup();
  }
});

test('only the managed ssh block is exported, not the user entries', async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      '.ssh/config',
      ['Host my-own', '  User root', '', '# >>> gs:managed >>>', 'Host gh', '  HostName github.com', '# <<< gs:managed <<<', ''].join('\n'),
    );
    const snapshot = await buildSnapshot({ home: h.home, profiles: profilesFor(h.home) });
    const block = snapshot.files.find((f) => f.path === 'ssh/config.managed');
    assert.ok(block);
    assert.match(block.content, /Host gh/);
    assert.ok(!block.content.includes('my-own'), 'user entries stay on their machine');
  } finally {
    await h.cleanup();
  }
});

test('encrypt/decrypt round-trips and rejects a wrong passphrase', async () => {
  const h = await createTmpHome();
  try {
    const snapshot = await buildSnapshot({ home: h.home, profiles: profilesFor(h.home) });
    const sealed = await encryptSnapshot(snapshot, 'correct horse battery');
    assert.ok(!sealed.includes('profiles.yaml'), 'payload is encrypted');
    assert.match(sealed, /"magic"/);

    const opened = await decryptSnapshot(sealed, 'correct horse battery');
    assert.equal(opened.files.length, snapshot.files.length);

    await assert.rejects(() => decryptSnapshot(sealed, 'wrong passphrase'), /wrong passphrase or corrupted/);
  } finally {
    await h.cleanup();
  }
});

test('a short passphrase is refused', async () => {
  const h = await createTmpHome();
  try {
    const snapshot = await buildSnapshot({ home: h.home, profiles: profilesFor(h.home) });
    await assert.rejects(() => encryptSnapshot(snapshot, 'short'), /at least 8/);
  } finally {
    await h.cleanup();
  }
});

test('exporting plaintext key material in a non-secret file is refused', async () => {
  const snapshot = {
    manifest: { format: 'gs-snapshot' as const, version: 1, createdAt: '', sourceHome: '', containsKeys: false, files: [] },
    files: [{ path: 'profiles.yaml', content: '-----BEGIN OPENSSH PRIVATE KEY-----', sha256: '' }],
  };
  assert.throws(() => assertNoPlaintextKeys(snapshot), /contains private key material/);
});

test('verifySnapshot detects a tampered file', async () => {
  const h = await createTmpHome();
  try {
    const snapshot = await buildSnapshot({ home: h.home, profiles: profilesFor(h.home) });
    const profile = snapshot.files.find((f) => f.path === 'profiles.yaml');
    assert.ok(profile);
    profile.content += '\n# tampered\n';

    const verdict = verifySnapshot(snapshot, h.home);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => /does not match its checksum/.test(p)));
  } finally {
    await h.cleanup();
  }
});

test('verifySnapshot accepts an intact snapshot and yields the profile', async () => {
  const h = await createTmpHome();
  try {
    const snapshot = await buildSnapshot({ home: h.home, profiles: profilesFor(h.home) });
    const verdict = verifySnapshot(snapshot, h.home);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.profiles?.identities.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('remap rewrites directory rules for a different machine layout', () => {
  const profiles = profilesFor('D:/CODE');
  const remaps = parseRemap(['D:/CODE=/home/me/code']);
  const mapped = remapProfiles(profiles, remaps);
  assert.equal(mapped.rules[0]?.dir, '/home/me/code/code/github');
  assert.ok(!mapped.rules[0]?.dir.includes('D:/CODE'));
});

test('remapPath only matches whole path segments', () => {
  const remaps = parseRemap(['D:/CODE=/home/me']);
  assert.equal(remapPath('D:/CODE/x', remaps), '/home/me/x');
  assert.equal(remapPath('D:/CODE', remaps), '/home/me');
  assert.equal(remapPath('D:/CODEX/y', remaps), 'D:/CODEX/y', 'no partial segment match');
});

test('invalid remap specifications are rejected', () => {
  assert.throws(() => parseRemap(['no-equals-sign']), /expected OLD=NEW/);
  assert.throws(() => parseRemap(['=only-right']), /expected OLD=NEW/);
});

test('backslashes in remap specs are normalised', () => {
  const [pair] = parseRemap(['D:\\CODE\\x=C:\\new\\y']);
  assert.deepEqual(pair, ['D:/CODE/x', 'C:/new/y']);
});
