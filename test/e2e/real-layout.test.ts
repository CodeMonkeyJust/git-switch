import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { loadProfiles, saveProfiles } from '../../src/core/profiles.ts';
import { plan } from '../../src/core/plan.ts';
import { apply } from '../../src/core/apply.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';

const run = promisify(execFile);
const posix = (p: string) => p.replace(/\\/g, '/');

async function gitEmail(home: string, cwd: string): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, 'config', 'user.email'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return stdout.trim();
}

/**
 * The end-to-end promise of the whole tool: after `gs apply`, plain git resolves
 * a different identity per directory. This test builds a code tree shaped like a
 * real developer machine (work / personal / unconfigured roots), applies, and
 * checks git's own answer in each repository.
 */
test('after apply, git resolves one identity per directory', async () => {
  const h = await createTmpHome();
  const code = path.join(h.home, 'code');
  try {
    const repos = {
      pde: path.join(code, 'PDE-GIT', 'pdes-ctcis'),
      gh: path.join(code, 'github', 'nocobase'),
      mine: path.join(code, 'MyGithub', 'new-api-stat'),
      unset: path.join(code, 'gitee', 'JeecgBoot'),
    };
    for (const dir of Object.values(repos)) {
      await mkdir(dir, { recursive: true });
      await run('git', ['init', '-q'], { cwd: dir });
    }

    await writeFile(
      path.join(h.home, '.gitconfig'),
      '[user]\n\tname = zhulj\n\temail = zhulj@pde.com.cn\n',
      'utf8',
    );

    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519
    sites:
      - host: git.pdesoft.cn
        port: 9092
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
rules:
  - dir: ${posix(code)}/PDE-GIT
    identity: work
  - dir: ${posix(code)}/github
    identity: personal
  - dir: ${posix(code)}/MyGithub
    identity: personal
`,
      h.home,
    );

    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    assert.equal(await gitEmail(h.home, repos.pde), 'zhulj@pde.com.cn');
    assert.equal(await gitEmail(h.home, repos.gh), 'zlj20@163.com');
    assert.equal(await gitEmail(h.home, repos.mine), 'zlj20@163.com', 'MyGithub shares the personal rule');
    assert.equal(
      await gitEmail(h.home, repos.unset),
      'zhulj@pde.com.cn',
      'a directory without a rule keeps the global identity',
    );
  } finally {
    await h.cleanup();
  }
});

test('editing one identity email and re-applying changes only that directory', async () => {
  const h = await createTmpHome();
  const code = path.join(h.home, 'code');
  try {
    const workRepo = path.join(code, 'work', 'repo');
    const personalRepo = path.join(code, 'personal', 'repo');
    for (const dir of [workRepo, personalRepo]) {
      await mkdir(dir, { recursive: true });
      await run('git', ['init', '-q'], { cwd: dir });
    }
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');

    const base = `schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: shared@example.com
    sshKey: k1
    sites:
      - host: work.example.com
  personal:
    user:
      name: b
      email: shared@example.com
    sshKey: k2
    sites:
      - host: personal.example.com
rules:
  - dir: ${posix(code)}/work
    identity: work
  - dir: ${posix(code)}/personal
    identity: personal
`;
    await saveProfiles(h.home, parseProfilesText(base, h.home));
    await apply(await plan({ home: h.home, profiles: await loadProfiles(h.home) }), { home: h.home });

    // both start identical: this is the situation init leaves behind
    assert.equal(await gitEmail(h.home, workRepo), 'shared@example.com');
    assert.equal(await gitEmail(h.home, personalRepo), 'shared@example.com');

    // the user edits just the personal identity, exactly as the init hint says
    const edited = base.replace(
      '  personal:\n    user:\n      name: b\n      email: shared@example.com',
      '  personal:\n    user:\n      name: b\n      email: me@personal.example',
    );
    await saveProfiles(h.home, parseProfilesText(edited, h.home));
    await apply(await plan({ home: h.home, profiles: await loadProfiles(h.home) }), { home: h.home });

    assert.equal(await gitEmail(h.home, workRepo), 'shared@example.com', 'work is untouched');
    assert.equal(await gitEmail(h.home, personalRepo), 'me@personal.example', 'personal changed');
  } finally {
    await h.cleanup();
  }
});

test('the generated gitconfig keeps foreign content and stays idempotent', async () => {
  const h = await createTmpHome();
  try {
    const foreign = '[user]\n\tname = zhulj\n\temail = z@example.com\n[credential "https://gitee.com"]\n\tprovider = generic\n';
    await writeFile(path.join(h.home, '.gitconfig'), foreign, 'utf8');

    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  p:
    user:
      name: p
      email: p@example.com
    sshKey: k
    sites:
      - host: github.com
rules:
  - dir: ${posix(h.home)}/code
    identity: p
`,
      h.home,
    );

    await apply(await plan({ home: h.home, profiles }), { home: h.home });
    const after = await readFile(path.join(h.home, '.gitconfig'), 'utf8');
    assert.ok(after.startsWith(foreign), 'foreign config is preserved verbatim');
    assert.match(after, /# >>> gs:managed >>>/);

    const second = await plan({ home: h.home, profiles });
    assert.equal(second.dirty, false, 'a second apply has nothing to do');
  } finally {
    await h.cleanup();
  }
});
