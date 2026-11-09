import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { buildSnapshot, encryptSnapshot, decryptSnapshot, verifySnapshot, remapProfiles, parseRemap } from '../../src/core/snapshot.ts';
import { generateKey } from '../../src/core/keys.ts';
import { loadProfiles, parseProfilesText, saveProfiles } from '../../src/core/profiles.ts';
import { writeFileAtomic } from '../../src/util/fs-atomic.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

/** The end-to-end goal: move a working setup from one machine to another. */
test('a snapshot migrates a profile to a differently laid out machine', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snapshotFile = path.join(source.home, 'snapshot.gsnap');

  try {
    // --- machine A ---
    await generateKey({ home: source.home, name: 'id_ed25519_github' });
    await saveProfiles(
      source.home,
      parseProfilesText(
        `schemaVersion: 1
identities:
  github:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519_pde
    sites:
      - host: git.pdesoft.cn
        port: 9092
        alias: pde
rules:
  - dir: ${posix(source.home)}/code/github
    identity: github
  - dir: ${posix(source.home)}/code/work
    identity: work
`,
        source.home,
      ),
    );

    const profilesA = await loadProfiles(source.home);
    const snapshot = await buildSnapshot({ home: source.home, profiles: profilesA });
    await writeFileAtomic(snapshotFile, JSON.stringify(snapshot, null, 2));

    // --- the move ---
    const raw = await readFile(snapshotFile, 'utf8');
    const parsed = JSON.parse(raw);
    const verdict = verifySnapshot(parsed, target.home);
    assert.equal(verdict.ok, true, verdict.problems.join('; '));

    const remaps = parseRemap([`${posix(source.home)}=${posix(target.home)}`]);
    assert.ok(verdict.profiles, 'the snapshot must yield a profile');
    const migrated = remapProfiles(verdict.profiles, remaps);

    await saveProfiles(target.home, migrated);

    // --- machine B ---
    const profilesB = await loadProfiles(target.home);
    assert.equal(profilesB.identities.length, 2);
    assert.equal(profilesB.sites.length, 2);

    for (const rule of profilesB.rules) {
      assert.ok(
        rule.dir.startsWith(posix(target.home)),
        `rule ${rule.dir} should live under the new home`,
      );
      assert.ok(!rule.dir.includes(posix(source.home)), `rule ${rule.dir} still references the old home`);
    }

    // identities and sites survive the trip unchanged
    const github = profilesB.identities.find((i) => i.name === 'github');
    assert.equal(github?.user.email, 'zlj20@163.com');
    assert.equal(github?.sshKey, 'id_ed25519_github');
    assert.ok(profilesB.sites.some((s) => s.host === 'git.pdesoft.cn' && s.port === 9092));
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('an encrypted snapshot migrates keys without exposing them at rest', async () => {
  const source = await createTmpHome();
  try {
    await generateKey({ home: source.home, name: 'id_secret' });
    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  a:
    user:
      name: a
      email: a@example.com
    sshKey: id_secret
rules: []
`,
      source.home,
    );
    const snapshot = await buildSnapshot({ home: source.home, profiles, includeKeys: true });
    const sealed = await encryptSnapshot(snapshot, 'a-long-enough-passphrase');

    assert.ok(!sealed.includes('OPENSSH PRIVATE KEY'), 'the file on disk holds no plaintext key');

    const opened = await decryptSnapshot(sealed, 'a-long-enough-passphrase');
    const keyFile = opened.files.find((f) => f.path === 'keys/id_secret');
    assert.ok(keyFile, 'the key travels inside the encrypted envelope');
    assert.match(keyFile.content, /OPENSSH PRIVATE KEY/);
  } finally {
    await source.cleanup();
  }
});
