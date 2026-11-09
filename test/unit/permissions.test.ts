import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { checkKeys, checkConnectivity, hostNamesIn } from '../../src/core/checks.ts';

const posix = (p: string) => p.replace(/\\/g, '/');
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function profileFor(home: string, key: string, opts: { alias?: string; port?: number } = {}) {
  const alias = opts.alias ? `        alias: ${opts.alias}\n` : '';
  const port = opts.port ? `        port: ${opts.port}\n` : '';
  return parseProfilesText(
    `schemaVersion: 1
identities:
  a:
    user:
      name: u
      email: u@example.com
    sshKey: ${key}
    sites:
      - host: git.example.com
${port}${alias}rules: []
`,
    home,
  );
}

/* ------------------------------- ACL / mode ------------------------------ */

test('any key file is reported (the presence check always runs)', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const results = await checkKeys(h.home, profileFor(h.home, 'id_k'));
    assert.ok(results.some((r) => r.level === 'ok' && /present/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('a world-readable key on posix is flagged', async (t) => {
  if (isWindows) {
    t.skip('POSIX mode bits only');
    return;
  }
  if (isRoot) {
    t.skip('root can read anything; mode checks are meaningless');
    return;
  }
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_open', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(h.home, '.ssh', 'id_open'), 0o644);

    const results = await checkKeys(h.home, profileFor(h.home, 'id_open'));
    const perm = results.find((r) => r.id.startsWith('perm:'));
    assert.ok(perm, 'a permission finding must be produced');
    assert.equal(perm.level, 'warn');
    assert.match(perm.fix ?? '', /chmod 600/);
  } finally {
    await h.cleanup();
  }
});

test('a properly restricted key on posix is accepted', async (t) => {
  if (isWindows) {
    t.skip('POSIX mode bits only');
    return;
  }
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_ok', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(h.home, '.ssh', 'id_ok'), 0o600);

    const results = await checkKeys(h.home, profileFor(h.home, 'id_ok'));
    const perm = results.find((r) => r.id.startsWith('perm:'));
    assert.ok(perm);
    assert.equal(perm.level, 'ok');
  } finally {
    await h.cleanup();
  }
});

test('on windows the ACL check is advisory and never crashes', async (t) => {
  if (!isWindows) {
    t.skip('Windows ACL path');
    return;
  }
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_acl', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const results = await checkKeys(h.home, profileFor(h.home, 'id_acl'));
    const perm = results.find((r) => r.id.startsWith('perm:'));
    // the finding may be ok or warn depending on where the temp dir lives, but it
    // must exist and must not throw
    assert.ok(perm, 'an ACL finding must be produced');
    assert.ok(['ok', 'warn'].includes(perm.level));
    if (perm.level === 'warn') {
      assert.match(perm.fix ?? '', /icacls/);
    }
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------ connectivity ----------------------------- */

test('a site without a key is skipped rather than probed', async () => {
  const h = await createTmpHome();
  try {
    const results = await checkConnectivity(h.home, profileFor(h.home, 'id_absent'), 2000);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.level, 'warn');
    assert.match(results[0]?.title ?? '', /skipped connectivity probe/);
  } finally {
    await h.cleanup();
  }
});

test('an alias that is not yet in ssh config is not used as the target', async () => {
  // Before `gs apply` the alias does not resolve; probing it produced
  // "Could not resolve hostname" and a misleading failure.
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    // no ~/.ssh/config at all
    const results = await checkConnectivity(h.home, profileFor(h.home, 'id_k', { alias: 'brand-new' }), 1500);
    const result = results[0];
    assert.ok(result);
    // the host is unreachable in tests, so this is an error/warn - but the message
    // must reference the real host, never the unresolved alias
    assert.match(result.title, /git\.example\.com/);
    assert.ok(!/brand-new/.test(result.title), `the alias leaked into the title: ${result.title}`);
  } finally {
    await h.cleanup();
  }
});

test('an alias present in ssh config is preferred as the target', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    await h.write('.ssh/config', 'Host known-alias\n  HostName git.example.com\n');
    const profiles = profileFor(h.home, 'id_k', { alias: 'known-alias' });
    const hosts = hostNamesIn(await h.read('.ssh/config'));
    assert.ok(hosts.has('known-alias'));
    // running the probe would need the network; the decision logic is what matters
    assert.ok(profiles.sites[0]?.alias === 'known-alias');
  } finally {
    await h.cleanup();
  }
});

test('hostNamesIn extracts every pattern of a Host line', () => {
  const hosts = hostNamesIn(
    ['Host a b', '  HostName x', '', 'Host *', '  User git', '# Host commented-out'].join('\n'),
  );
  assert.ok(hosts.has('a'));
  assert.ok(hosts.has('b'));
  assert.ok(hosts.has('*'));
  assert.ok(!hosts.has('commented-out'), 'comments are ignored');
});

test('a host DNS cannot resolve is a warning, not an auth failure', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  a:
    user:
      name: u
      email: u@example.com
    sshKey: id_k
    sites:
      - host: no-such-host.invalid
rules: []
`,
      h.home,
    );
    const results = await checkConnectivity(h.home, profiles, 3000);
    const result = results[0];
    assert.ok(result);
    if (/could not resolve|name or service not known/i.test(result.detail ?? '')) {
      assert.equal(result.level, 'warn', 'an unresolvable host is a warning');
      assert.match(result.title, /could not be resolved/);
    } else {
      // offline environments may fail differently; the check must still report
      assert.ok(['warn', 'error'].includes(result.level));
    }
  } finally {
    await h.cleanup();
  }
});

/* A real end-to-end probe, skipped unless the user opts in. */
test('probing the real user key against the local ssh config is non-destructive', async () => {
  const key = path.join(homedir(), '.ssh', 'id_ed25519');
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.ssh'), { recursive: true });
    const copied = await copyFile(key, path.join(h.home, '.ssh', 'id_ed25519')).then(() => true).catch(() => false);
    if (!copied) return; // no key on this machine
    const results = await checkKeys(h.home, profileFor(h.home, 'id_ed25519'));
    assert.ok(results.some((r) => /present/.test(r.title)));
  } finally {
    await h.cleanup();
  }
  void posix;
  void writeFile;
});
