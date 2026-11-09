import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { initCommand } from '../../src/commands/init.ts';
import { loadProfiles } from '../../src/core/profiles.ts';
import { plan } from '../../src/core/plan.ts';
import { apply } from '../../src/core/apply.ts';
import { createLogger } from '../../src/util/log.ts';

const run = promisify(execFile);
const posix = (p: string) => p.replace(/\\/g, '/');

async function gitIn(home: string, cwd: string, args: string[]) {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout;
}

/**
 * The acceptance test for "gs is usable": start from a machine with SSH hosts and
 * repositories but no profile, then reach a working multi-identity setup with
 * init -> apply, verified by real git.
 */
test('from nothing to a working setup: init then apply', async () => {
  const h = await createTmpHome();

  // a machine as it looks before gs: global identity, ssh hosts, repos
  await h.write('.gitconfig', '[user]\n\tname = zhulj\n\temail = zhulj@pde.com.cn\n');
  await h.write(
    '.ssh/config',
    [
      'Host github.com',
      '  HostName ssh.github.com',
      '  Port 443',
      '  User git',
      '  IdentityFile ~/.ssh/id_ed25519_github',
      '  IdentitiesOnly yes',
      '',
      'Host pdesoft',
      '  HostName git.pdesoft.cn',
      '  Port 9092',
      '  User git',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
    ].join('\n'),
  );
  await h.write('.ssh/id_ed25519', 'placeholder');
  await h.write('.ssh/id_ed25519.pub', 'placeholder');
  await h.write('.ssh/id_ed25519_github', 'placeholder');
  await h.write('.ssh/id_ed25519_github.pub', 'placeholder');

  const repos = [
    { dir: 'code/github/nocobase', remote: 'git@github.com:nocobase/nocobase.git' },
    { dir: 'code/PDE-GIT/pdes-ctcis', remote: 'ssh://git@git.pdesoft.cn:9092/PDES4.0/x.git' },
  ];
  for (const repo of repos) {
    const dir = path.join(h.home, repo.dir);
    await mkdir(dir, { recursive: true });
    await gitIn(h.home, dir, ['init', '-q']);
    await gitIn(h.home, dir, ['remote', 'add', 'origin', repo.remote]);
  }

  try {
    // 1. init
    const logger = createLogger({ color: false, stream: process.stderr });
    const code = await initCommand({
      home: h.home,
      roots: [path.join(h.home, 'code')],
      logger,
    });
    assert.equal(code, 0);

    const profiles = await loadProfiles(h.home);
    assert.ok(profiles.rules.length >= 2, 'a rule was inferred for each top-level folder');

    // 2. apply
    const p = await plan({ home: h.home, profiles });
    assert.equal(p.errors.length, 0, `plan errors: ${p.errors.join('; ')}`);
    assert.ok(p.dirty);
    await apply(p, { home: h.home });

    // 3. a second apply must be a no-op
    const again = await plan({ home: h.home, profiles });
    assert.equal(again.dirty, false, 'apply is idempotent');

    // 4. real git resolves per-directory identities and routes remotes
    const ghDir = path.join(h.home, 'code', 'github', 'nocobase');
    const pdeDir = path.join(h.home, 'code', 'PDE-GIT', 'pdes-ctcis');

    const ghOrigin = await gitIn(h.home, ghDir, ['config', '--show-origin', '--get', 'user.email']);
    assert.match(ghOrigin, /identities[\/\\]github\.gitconfig/);

    const pdeOrigin = await gitIn(h.home, pdeDir, ['config', '--show-origin', '--get', 'user.email']);
    assert.match(pdeOrigin, /identities[\/\\]pdesoft\.gitconfig/);

    // the github remote must stay pointed at github.com, routed via the alias
    const routed = await gitIn(h.home, ghDir, ['ls-remote', '--get-url', 'origin']);
    assert.equal(routed.trim(), 'git@github:nocobase/nocobase.git');

    // the pde remote must be routed through its own alias, with the custom port
    // removed from the path (ssh config supplies it)
    const pdeRouted = await gitIn(h.home, pdeDir, ['ls-remote', '--get-url', 'origin']);
    assert.match(pdeRouted.trim(), /^git@[^:]+:PDES4\.0\/x\.git$/, `unexpected route: ${pdeRouted}`);
    assert.ok(!/:9092\//.test(pdeRouted), 'the port must not leak into the path');

    // 5. the ssh config keeps the user's original entries untouched
    const sshText = await readFile(path.join(h.home, '.ssh', 'config'), 'utf8');
    assert.ok(sshText.startsWith('Host github.com\n  HostName ssh.github.com'));
  } finally {
    await h.cleanup();
  }
});

test('init refuses to clobber an existing profile without --force', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.gitconfig', '[user]\n\tname = a\n\temail = a@example.com\n');
    await h.write('.config/gs/profiles.yaml', 'schemaVersion: 1\nidentities: {}\n');
    const logger = createLogger({ color: false, stream: process.stderr });
    const code = await initCommand({ home: h.home, roots: [h.home], logger });
    assert.equal(code, 2);
    assert.match(await h.read('.config/gs/profiles.yaml'), /identities: \{\}/);
  } finally {
    await h.cleanup();
  }
});

export { posix };
