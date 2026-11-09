import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { checkKeys, checkSshConfig, checkGitIdentityForDirectory } from '../../src/core/checks.ts';
import { plan } from '../../src/core/plan.ts';
import { apply } from '../../src/core/apply.ts';

const run = promisify(execFile);
const posix = (p: string) => p.replace(/\\/g, '/');

function profileFor(home: string, key: string | undefined): ReturnType<typeof parseProfilesText> {
  const keyLine = key ? `    sshKey: ${key}\n` : '';
  return parseProfilesText(
    `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
${keyLine}    sites:
      - host: git.pdesoft.cn
        port: 9092
        alias: pde
rules:
  - dir: ${posix(home)}/code/work
    identity: work
`,
    home,
  );
}

test('checkKeys reports a missing key as an error, not a silent pass', async () => {
  const h = await createTmpHome();
  try {
    const results = await checkKeys(h.home, profileFor(h.home, 'id_ed25519_missing'));
    const error = results.find((r) => r.level === 'error');
    assert.ok(error, 'a missing key must be an error');
    assert.match(error.title, /does not exist/);
    assert.match(error.detail ?? '', /no such identity/);
    assert.match(error.fix ?? '', /ssh-keygen/);
  } finally {
    await h.cleanup();
  }
});

test('checkKeys reports an identity without a key as a warning', async () => {
  const h = await createTmpHome();
  try {
    const results = await checkKeys(h.home, profileFor(h.home, undefined));
    assert.ok(results.some((r) => r.level === 'warn' && /no SSH key/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('checkKeys passes once the key exists', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_ed25519_ok', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const results = await checkKeys(h.home, profileFor(h.home, 'id_ed25519_ok'));
    assert.equal(results.filter((r) => r.level === 'error').length, 0);
    assert.ok(results.some((r) => r.level === 'ok' && /present/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('a file that is not a private key is reported as a warning', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/id_ed25519_bad', 'this is not a key');
    const results = await checkKeys(h.home, profileFor(h.home, 'id_ed25519_bad'));
    assert.ok(results.some((r) => r.level === 'warn' && /does not look like a private key/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('checkSshConfig flags a missing managed block', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.ssh/config', 'Host existing\n  User root\n');
    const results = await checkSshConfig(h.home, profileFor(h.home, 'id_ed25519'));
    assert.ok(results.some((r) => r.level === 'warn' && /no gs managed block/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('checkSshConfig detects an alias shadowed by the user`s own Host block', async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      '.ssh/config',
      ['Host pde', '  User root', '', '# >>> gs:managed >>>', 'Host pde2', '  HostName x', '# <<< gs:managed <<<', ''].join('\n'),
    );
    const results = await checkSshConfig(h.home, profileFor(h.home, 'id_ed25519'));
    assert.ok(results.some((r) => r.level === 'warn' && /defined outside the gs block/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('checkGitIdentityForDirectory warns when the directory is not a repository', async () => {
  const h = await createTmpHome();
  try {
    const dir = path.join(h.home, 'code', 'work');
    await mkdir(dir, { recursive: true });
    const results = await checkGitIdentityForDirectory(h.home, profileFor(h.home, 'k'), dir);
    assert.ok(results.some((r) => r.level === 'warn' && /not a Git repository/.test(r.title)));
  } finally {
    await h.cleanup();
  }
});

test('checkGitIdentityForDirectory confirms a gs-managed identity inside a repo', async () => {
  const h = await createTmpHome();
  try {
    const dir = path.join(h.home, 'code', 'work', 'repo');
    await mkdir(dir, { recursive: true });
    await h.write('.gitconfig', '');
    await run('git', ['init', '-q'], { cwd: dir });
    const profiles = profileFor(h.home, undefined);
    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    const results = await checkGitIdentityForDirectory(h.home, profiles, dir);
    const identity = results.find((r) => r.id === 'dir:identity');
    assert.ok(identity);
    assert.equal(identity.level, 'ok');
    assert.match(identity.title, /identity here: zhulj@pde\.com\.cn/);
  } finally {
    await h.cleanup();
  }
});

test('checkSshConfig warns when a wildcard block pins IdentityFile', async () => {
  const h = await createTmpHome();
  try {
    // OpenSSH applies `Host *` IdentityFile entries before host-specific ones,
    // so ssh offers the wrong key first and auth can fail.
    await h.write(
      '.ssh/config',
      [
        'Host *',
        '  ServerAliveInterval 60',
        '  IdentityFile ~/.ssh/id_default',
        '',
        '# >>> gs:managed >>>',
        'Host gh',
        '  HostName github.com',
        '# <<< gs:managed <<<',
        '',
      ].join('\n'),
    );
    const results = await checkSshConfig(h.home, profileFor(h.home, 'id_ed25519'));
    const warning = results.find((r) => r.id === 'ssh:wildcard-key');
    assert.ok(warning, 'wildcard IdentityFile must be reported');
    assert.equal(warning.level, 'warn');
    assert.match(warning.detail ?? '', /wildcard IdentityFile entries before host-specific/);
    assert.match(warning.fix ?? '', /remove IdentityFile from the wildcard block/);
  } finally {
    await h.cleanup();
  }
});

test('a wildcard block without IdentityFile is not flagged', async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      '.ssh/config',
      ['Host *', '  ServerAliveInterval 60', '', '# >>> gs:managed >>>', 'Host gh', '# <<< gs:managed <<<'].join('\n'),
    );
    const results = await checkSshConfig(h.home, profileFor(h.home, 'id_ed25519'));
    assert.equal(results.find((r) => r.id === 'ssh:wildcard-key'), undefined);
  } finally {
    await h.cleanup();
  }
});

test('checkGitIdentityForDirectory flags a repository-local identity override', async () => {
  const h = await createTmpHome();
  try {
    const dir = path.join(h.home, 'code', 'work', 'repo');
    await mkdir(dir, { recursive: true });
    await h.write('.gitconfig', '[user]\n\temail = global@example.com\n');
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['config', 'user.email', 'stale@old.example'], { cwd: dir });

    const results = await checkGitIdentityForDirectory(h.home, profileFor(h.home, 'k'), dir);
    const override = results.find((r) => r.id === 'dir:repo-local-identity');
    assert.ok(override, 'a local user.email must be reported');
    assert.equal(override.level, 'warn');
    assert.match(override.title, /stale@old\.example/);
    assert.match(override.fix ?? '', /--unset user\.email/);
  } finally {
    await h.cleanup();
  }
});

test('plan warns when a referenced key does not exist', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.gitconfig', '');
    const p = await plan({ home: h.home, profiles: profileFor(h.home, 'id_ed25519_missing') });
    assert.ok(p.warnings.some((w) => /does not exist/.test(w) && /gs doctor/.test(w)));
  } finally {
    await h.cleanup();
  }
});
