import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteTarget, DEFAULT_KEY_NAMES } from '../../src/core/discover.ts';
import { availableKeys } from '../../src/core/probe.ts';
import { createTmpHome } from '../helpers/tmp-home.ts';

test('parseRemoteTarget extracts host, port and user from ssh:// remotes', () => {
  const target = parseRemoteTarget('ssh://git@git.company.example:9092/group/x.git');
  assert.deepEqual(target, { host: 'git.company.example', port: 9092, user: 'git' });
});

test('parseRemoteTarget extracts host and user from scp-style remotes', () => {
  assert.deepEqual(parseRemoteTarget('git@github.com:owner/repo.git'), {
    host: 'github.com',
    user: 'git',
  });
});

test('parseRemoteTarget extracts host from https remotes', () => {
  assert.deepEqual(parseRemoteTarget('https://gitee.com/jeecg/JeecgBoot.git'), { host: 'gitee.com' });
});

test('parseRemoteTarget returns undefined for unparseable input', () => {
  assert.equal(parseRemoteTarget(''), undefined);
  assert.equal(parseRemoteTarget('not a url'), undefined);
});

test('default key names are listed in ssh preference order', () => {
  assert.ok(DEFAULT_KEY_NAMES.includes('id_ed25519'));
  assert.ok(DEFAULT_KEY_NAMES.includes('id_rsa'));
  assert.ok(DEFAULT_KEY_NAMES.indexOf('id_rsa') < DEFAULT_KEY_NAMES.indexOf('id_ed25519'));
});

test('availableKeys lists default keys first, then custom ones', async () => {
  const h = await createTmpHome();
  try {
    for (const name of ['id_ed25519_github', 'id_ed25519', 'id_work']) {
      await h.write(`.ssh/${name}`, '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    }
    await h.write('.ssh/id_ed25519.pub', 'ssh-ed25519 AAAA x\n');
    await h.write('.ssh/config', 'Host x\n');
    await h.write('.ssh/known_hosts', 'entry');

    const keys = await availableKeys(h.home);
    assert.equal(keys[0], 'id_ed25519', 'default names come first');
    assert.ok(keys.includes('id_ed25519_github'));
    assert.ok(keys.includes('id_work'));
    assert.ok(!keys.some((k) => k.endsWith('.pub')), 'public keys are not candidates');
    assert.ok(!keys.includes('config'));
    assert.ok(!keys.includes('known_hosts'));
  } finally {
    await h.cleanup();
  }
});

test('availableKeys returns an empty list when ~/.ssh is absent', async () => {
  const h = await createTmpHome();
  try {
    assert.deepEqual(await availableKeys(h.home), []);
  } finally {
    await h.cleanup();
  }
});
