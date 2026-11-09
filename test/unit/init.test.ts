import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalHost,
  parseRemoteHost,
  parseSshConfig,
  sshKeyName,
  groupRepositories,
  type Discovery,
} from '../../src/core/discover.ts';
import { buildProfiles } from '../../src/commands/init.ts';

const HOME = '/home/tester';

test('parseRemoteHost understands scp, ssh:// and https:// remotes', () => {
  assert.equal(parseRemoteHost('git@github.com:owner/repo.git'), 'github.com');
  assert.equal(parseRemoteHost('ssh://git@git.pdesoft.cn:9092/PDES4.0/x.git'), 'git.pdesoft.cn');
  assert.equal(parseRemoteHost('https://gitee.com/jeecg/JeecgBoot.git'), 'gitee.com');
  assert.equal(parseRemoteHost('git://host/repo.git'), 'host');
  assert.equal(parseRemoteHost(''), undefined);
});

test('parseSshConfig extracts hosts that pin an identity file', () => {
  const hosts = parseSshConfig(`
Host 192.168.12.60
  HostName 192.168.12.60
  User root
  ForwardAgent yes

Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes

Host *
  ServerAliveInterval 60
`);
  assert.equal(hosts.length, 1, 'only the block with an IdentityFile is reported');
  const gh = hosts[0] as (typeof hosts)[number];
  assert.equal(gh.host, 'ssh.github.com');
  assert.equal(gh.port, 443);
  assert.equal(sshKeyName(gh.identityFile as string), 'id_ed25519_github');
});

test('parseSshConfig skips wildcard host blocks', () => {
  const hosts = parseSshConfig(`
Host *.internal
  IdentityFile ~/.ssh/internal
`);
  assert.equal(hosts.length, 0);
});

test('canonicalHost collapses the port-443 github endpoint', () => {
  assert.equal(canonicalHost('ssh.github.com'), 'github.com');
  assert.equal(canonicalHost('GitHub.com'), 'github.com');
  assert.equal(canonicalHost('gitee.com'), 'gitee.com');
});

test('groupRepositories groups by top-level folder', () => {
  const repos = [
    { path: '/code/github/a', remoteHost: 'github.com' },
    { path: '/code/github/b', remoteHost: 'github.com' },
    { path: '/code/work/c', remoteHost: 'git.company.com' },
  ];
  const groups = groupRepositories(repos, '/code');
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.dir.endsWith('/code/github'))?.count, 2);
  assert.equal(groups.find((g) => g.dir.endsWith('/code/work'))?.remoteHost, 'git.company.com');
});

test('a repository directly under the scan root is its own group', () => {
  // `code/myrepo` with the scan root `code`: previously dropped entirely, which
  // meant `gs init` produced no rule for that repository.
  const groups = groupRepositories([{ path: '/code/myrepo', remoteHost: 'gitee.com' }], '/code');
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.dir, '/code/myrepo');
  assert.equal(groups[0]?.remoteHost, 'gitee.com');
  assert.equal(groups[0]?.count, 1);
});

test('a mixed layout groups loose and nested repositories together', () => {
  const groups = groupRepositories(
    [
      { path: '/code/loose', remoteHost: 'gitee.com' },
      { path: '/code/github/deep/repo', remoteHost: 'github.com' },
    ],
    '/code',
  );
  assert.equal(groups.length, 2);
  assert.ok(groups.some((g) => g.dir === '/code/loose'));
  assert.ok(groups.some((g) => g.dir === '/code/github'));
});

test('groupRepositories ignores a repo at the scan root itself', () => {
  assert.equal(groupRepositories([{ path: '/code' }], '/code').length, 0);
});

test('groupRepositories tolerates a trailing separator on the root', () => {
  const groups = groupRepositories([{ path: '/code/github/a' }], '/code/');
  assert.equal(groups[0]?.dir, '/code/github');
});

test('sshKeyName strips the directory and .pub suffix', () => {
  assert.equal(sshKeyName('~/.ssh/id_ed25519_github'), 'id_ed25519_github');
  assert.equal(sshKeyName('/home/t/id_ed25519'), 'id_ed25519');
  assert.equal(sshKeyName('id_ed25519.pub'), 'id_ed25519');
});

test('buildProfiles merges alternate SSH endpoints into one identity', () => {
  const found: Discovery = {
    gitUser: { name: 'zhulj', email: 'zhulj@pde.com.cn' },
    hosts: [
      { host: 'ssh.github.com', port: 443, user: 'git', identityFile: '~/.ssh/id_ed25519_github', aliases: ['github.com'] },
      { host: 'git.pdesoft.cn', port: 9092, user: 'git', identityFile: '~/.ssh/id_ed25519', aliases: ['pdesoft'] },
    ],
    repos: [],
    groups: [
      { dir: `${HOME}/code/github`, count: 2, remoteHost: 'github.com' },
      { dir: `${HOME}/code/PDE-GIT`, count: 1, remoteHost: 'git.pdesoft.cn' },
    ],
    warnings: [],
  };

  const profiles = buildProfiles(found, { home: HOME, roots: [`${HOME}/code`], groups: [] });

  assert.equal(profiles.identities.length, 2, 'ssh.github.com must not create a second github identity');
  const github = profiles.identities.find((i) => i.name === 'github');
  assert.ok(github, 'github identity exists');
  assert.equal(github.sshKey, 'id_ed25519_github');

  const site = profiles.sites.find((s) => s.identity === 'github');
  assert.equal(site?.host, 'github.com', 'host is the real git host');
  assert.equal(site?.sshHostName, 'ssh.github.com', 'endpoint kept separately');
  assert.equal(site?.port, 443);

  assert.equal(profiles.rules.length, 2);
  assert.equal(profiles.rules.find((r) => r.dir.endsWith('/github'))?.identity, 'github');
});

test('buildProfiles falls back to the global identity when no ssh hosts exist', () => {
  const found: Discovery = {
    gitUser: { name: 'solo', email: 'solo@example.com' },
    hosts: [],
    repos: [],
    groups: [{ dir: `${HOME}/code/a`, count: 1 }],
    warnings: [],
  };
  const profiles = buildProfiles(found, { home: HOME, roots: [`${HOME}/code`], groups: [] });
  assert.equal(profiles.identities.length, 1);
  assert.equal(profiles.identities[0]?.name, 'default');
  assert.equal(profiles.rules[0]?.identity, 'default');
});

test('buildProfiles creates identities for remote hosts missing from ssh config', () => {
  const found: Discovery = {
    gitUser: { name: 'u', email: 'u@example.com' },
    hosts: [],
    repos: [{ path: `${HOME}/code/gitee/x`, remoteHost: 'gitee.com' }],
    groups: [{ dir: `${HOME}/code/gitee`, count: 1, remoteHost: 'gitee.com' }],
    warnings: [],
  };
  const profiles = buildProfiles(found, { home: HOME, roots: [`${HOME}/code`], groups: [] });
  const gitee = profiles.identities.find((i) => i.name === 'gitee');
  assert.ok(gitee, 'a gitee identity is created from the remote');
  assert.equal(gitee.sshKey, undefined, 'no key is invented');
  assert.equal(profiles.rules[0]?.identity, 'gitee');
});

test('buildProfiles avoids absurd aliases for IP and generic hosts', () => {
  const found: Discovery = {
    hosts: [
      { host: '192.168.12.60', user: 'root', identityFile: '~/.ssh/id_ed25519', aliases: ['192.168.12.60'] },
      { host: 'ssh.gitlab.com', port: 443, identityFile: '~/.ssh/id_gl', aliases: ['gitlab.com'] },
    ],
    repos: [],
    groups: [],
    warnings: [],
  };
  const profiles = buildProfiles(found, { home: HOME, roots: [], groups: [] });
  for (const site of profiles.sites) {
    assert.ok(!/^\d+$/.test(site.alias ?? ''), `alias must not be numeric: ${site.alias}`);
    assert.notEqual(site.alias, 'ssh', 'alias must not be the generic "ssh"');
  }
  assert.ok(profiles.identities.some((i) => i.name === 'internal'));
  assert.ok(profiles.identities.some((i) => i.name === 'gitlab'));
});
