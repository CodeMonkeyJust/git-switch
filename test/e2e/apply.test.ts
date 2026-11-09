import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { plan } from '../../src/core/plan.ts';
import { apply, HandEditError } from '../../src/core/apply.ts';
import { findBlock } from '../../src/core/managed-block.ts';

const run = promisify(execFile);

const PROFILE = (home: string) => `schemaVersion: 1
identities:
  personal:
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
    sshKey: id_ed25519
    sites:
      - host: git.pdesoft.cn
        port: 9092
        alias: pde
rules:
  - dir: ${home}/code/personal
    identity: personal
  - dir: ${home}/code/work
    identity: work
settings:
  backupKeep: 5
`;

const posix = (p: string) => p.replace(/\\/g, '/');

/** Run real git with this home, ignoring the developer's global config. */
async function git(home: string, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return stdout;
}

async function setup() {
  const h = await createTmpHome();
  await mkdir(path.join(h.home, 'code', 'personal', 'repo'), { recursive: true });
  await mkdir(path.join(h.home, 'code', 'work', 'repo'), { recursive: true });
  const profiles = parseProfilesText(PROFILE(posix(h.home)), h.home);
  return { h, profiles };
}

/**
 * `includeIf "gitdir:..."` only applies while git resolves a repository, so the
 * monitored directories must actually be repos for the identity mapping to take
 * effect. This mirrors real usage: you work inside repositories.
 */
async function initRepo(home: string, dir: string): Promise<void> {
  await run('git', ['init', '-q'], {
    cwd: dir,
    env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

test('apply writes the includeIf block into ~/.gitconfig', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '[user]\n\tname = someone\n\temail = x@y.z\n');
    const p = await plan({ home: h.home, profiles });
    assert.ok(p.dirty);
    await apply(p, { home: h.home });

    const text = await h.read('.gitconfig');
    assert.ok(text.startsWith('[user]\n\tname = someone\n\temail = x@y.z\n'), 'foreign content preserved');
    const block = findBlock(text);
    assert.ok(block.present, 'managed block present');
    assert.match(block.content, /\[includeIf "gitdir:.*\/code\/personal\/"\]/);
    assert.match(block.content, /personal\.gitconfig/);
    assert.match(block.content, /\[includeIf "gitdir:.*\/code\/work\/"\]/);
  } finally {
    await h.cleanup();
  }
});

test('git really resolves the identity from the directory', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    await initRepo(h.home, path.join(h.home, 'code', 'personal', 'repo'));
    await initRepo(h.home, path.join(h.home, 'code', 'work', 'repo'));

    const personalEmail = await git(h.home, path.join(h.home, 'code', 'personal', 'repo'), ['config', 'user.email']);
    const workEmail = await git(h.home, path.join(h.home, 'code', 'work', 'repo'), ['config', 'user.email']);

    assert.equal(personalEmail.trim(), 'zlj20@163.com');
    assert.equal(workEmail.trim(), 'zhulj@pde.com.cn');
  } finally {
    await h.cleanup();
  }
});

test('a subdirectory of a repo inherits the directory rule', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const deep = path.join(h.home, 'code', 'work', 'repo', 'packages', 'api');
    await mkdir(deep, { recursive: true });
    await initRepo(h.home, path.join(h.home, 'code', 'work', 'repo'));

    assert.equal((await git(h.home, deep, ['config', 'user.email'])).trim(), 'zhulj@pde.com.cn');
  } finally {
    await h.cleanup();
  }
});

test('a repo outside any rule keeps the global identity', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '[user]\n\tname = base\n\temail = base@example.com\n');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const outside = path.join(h.home, 'elsewhere', 'repo');
    await mkdir(outside, { recursive: true });
    await initRepo(h.home, outside);

    assert.equal((await git(h.home, outside, ['config', 'user.email'])).trim(), 'base@example.com');
  } finally {
    await h.cleanup();
  }
});

test('git reports the generated file as the origin of the identity', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    await initRepo(h.home, path.join(h.home, 'code', 'work', 'repo'));
    const out = await git(h.home, path.join(h.home, 'code', 'work', 'repo'), [
      'config',
      '--show-origin',
      '--get',
      'user.email',
    ]);
    assert.match(out, /identities[\/\\]work\.gitconfig/);
  } finally {
    await h.cleanup();
  }
});

test('apply is idempotent: the second run changes nothing', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    const first = await apply(await plan({ home: h.home, profiles }), { home: h.home });
    assert.equal(first.written.length, 4);

    const snapshot = await h.read('.gitconfig');
    const secondPlan = await plan({ home: h.home, profiles });
    assert.equal(secondPlan.dirty, false);
    const second = await apply(secondPlan, { home: h.home });
    assert.deepEqual(second.written, []);
    assert.equal(await h.read('.gitconfig'), snapshot);
  } finally {
    await h.cleanup();
  }
});

test('apply backs up the original before writing', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '[user]\n\tname = original\n');
    const res = await apply(await plan({ home: h.home, profiles }), { home: h.home });
    assert.ok(res.backups.length >= 1);
    const backup = await readFile(res.backups[0] as string, 'utf8');
    assert.match(backup, /name = original/);
  } finally {
    await h.cleanup();
  }
});

test('backup names are readable, not escaped full paths', async () => {
  const { h, profiles } = await setup();
  try {
    // both files must pre-exist for a backup to be taken
    await h.write('.gitconfig', '[user]\n\tname = original\n');
    await h.write('.ssh/config', 'Host mine\n  User root\n');
    const res = await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const names = res.backups.map((b) => path.basename(b));

    const gitConfigBackup = names.find((n) => n.startsWith('gitconfig.'));
    assert.ok(gitConfigBackup, `expected a gitconfig.*.bak, got ${names.join(', ')}`);
    assert.match(gitConfigBackup, /^gitconfig\.\d{8}-\d{6}\.bak$/);

    const sshBackup = names.find((n) => n.startsWith('ssh-config.'));
    assert.ok(sshBackup, `expected an ssh-config.*.bak, got ${names.join(', ')}`);
    assert.match(sshBackup, /^ssh-config\.\d{8}-\d{6}\.bak$/);

    // the home directory must not be smeared into the file name
    const homeSlug = path.basename(h.home).slice(0, 8);
    for (const name of names) {
      assert.ok(!name.includes(homeSlug), `backup name leaks the temp home: ${name}`);
      assert.ok(name.length < 80, `backup name is unreasonably long: ${name}`);
      assert.ok(!name.includes('__'), `backup name contains escaped separators: ${name}`);
    }
  } finally {
    await h.cleanup();
  }
});

test('CRLF ~/.gitconfig keeps its line endings', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '[user]\r\n\tname = win\r\n');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const text = await readFile(h.path('.gitconfig'), 'utf8');
    assert.ok(!/(?<!\r)\n/.test(text), 'no bare LF introduced');
    assert.match(text, /^\[user\]\r\n\tname = win\r\n/);
  } finally {
    await h.cleanup();
  }
});

test('apply refuses to overwrite a file changed after planning', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    const p = await plan({ home: h.home, profiles });
    // simulate a concurrent edit between plan and apply
    await h.write('.gitconfig', '[user]\n\tname = edited-by-hand\n');
    await assert.rejects(() => apply(p, { home: h.home }), HandEditError);
    assert.match(await h.read('.gitconfig'), /edited-by-hand/);
  } finally {
    await h.cleanup();
  }
});

test('ssh config gets one Host per site with IdentitiesOnly yes', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.ssh/config', 'Host 192.168.12.60\n\tUser root\n');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const text = await h.read('.ssh/config');
    assert.ok(text.startsWith('Host 192.168.12.60\n\tUser root\n'), 'existing host preserved');
    const block = findBlock(text);
    assert.match(block.content, /Host gh[\s\S]*?HostName github\.com/);
    assert.match(block.content, /Host pde[\s\S]*?Port 9092/);
    assert.equal(block.content.match(/IdentitiesOnly yes/g)?.length, 2);
  } finally {
    await h.cleanup();
  }
});

test('manual includeIf entries outside the block are reported as a warning', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '[includeIf "gitdir:/somewhere/"]\n\tpath = /tmp/x\n');
    const p = await plan({ home: h.home, profiles });
    assert.ok(p.warnings.some((w) => w.includes('includeIf')), 'warning mentions includeIf');
  } finally {
    await h.cleanup();
  }
});

test('removing all rules empties the managed block', async () => {
  const { h, profiles } = await setup();
  try {
    await h.write('.gitconfig', '');
    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    const empty = { ...profiles, rules: [] };
    await apply(await plan({ home: h.home, profiles: empty }), { home: h.home });
    const text = await h.read('.gitconfig');
    assert.ok(!text.includes('gs:managed'), 'block removed when there is nothing to manage');
  } finally {
    await h.cleanup();
  }
});
