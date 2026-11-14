import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIncludeIfBlock, renderIdentityConfig } from '../../src/core/render/gitconfig.ts';
import { buildHosts, buildHostsDetailed, renderSshBlock, aliasesForIdentity } from '../../src/core/render/ssh-config.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import type { Profiles } from '../../src/core/model.ts';
import { plan } from '../../src/core/plan.ts';
import { createTmpHome } from '../helpers/tmp-home.ts';
import path from 'node:path';

const HOME = '/home/tester';

function load(text: string): Profiles {
  return parseProfilesText(text, HOME);
}

const PROFILE = `schemaVersion: 1
identities:
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sshKey: id_ed25519
    sites:
      - host: git.company.example
        port: 9092
        alias: work
rules:
  - dir: ${HOME}/code/personal
    identity: personal
  - dir: ${HOME}/code/work
    identity: work
`;

test('includeIf uses an absolute forward-slash path with trailing slash', () => {
  const profiles = load(PROFILE);
  const body = renderIncludeIfBlock(profiles, {
    identityConfigPath: (id) => `/home/tester/.config/gs/identities/${id}.gitconfig`,
    contract: (p) => p.replace('/home/tester', '~'),
  });
  assert.match(body, /\[includeIf "gitdir:\/home\/tester\/code\/personal\/"\]/);
  assert.match(body, /path = ~\/\.config\/gs\/identities\/personal\.gitconfig/);
  assert.ok(!body.includes('\\'), 'no backslashes allowed in gitdir values');
});

test('identity config carries user identity and alias routing', () => {
  const profiles = load(PROFILE);
  const body = renderIdentityConfig(profiles, 'personal', {
    aliasFor: () => [{ alias: 'gh', hosts: ['github.com'] }],
  });
  assert.match(body, /\[user\]/);
  assert.match(body, /name = alexchen/);
  assert.match(body, /email = alex@personal.example/);
  assert.match(body, /\[url "git@gh:"\]/);
  assert.match(body, /insteadOf = git@github\.com:/);
  assert.match(body, /insteadOf = https:\/\/github\.com\//);
});

test('insteadOf routes the real git host, never the ssh endpoint', () => {
  const profiles = load(`schemaVersion: 1
identities:
  gh:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        sshHostName: ssh.github.com
        port: 443
        alias: gh
rules: []
`);
  const body = renderIdentityConfig(profiles, 'gh', { aliasFor: (n) => aliasesForIdentity(profiles, n) });
  assert.match(body, /insteadOf = git@github\.com:/);
  assert.ok(!body.includes('ssh.github.com'), 'SSH endpoint must not be used for URL routing');
});

test('the rendered ssh block dials sshHostName for port 443 fallback', () => {
  const profiles = load(`schemaVersion: 1
identities:
  gh:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        sshHostName: ssh.github.com
        port: 443
        alias: gh
rules: []
`);
  const block = renderSshBlock(buildHosts(profiles));
  assert.match(block, /Host gh\n\tHostName ssh\.github\.com\n\tPort 443/);
});

test('alsoRoutes produces extra insteadOf entries', () => {
  const profiles = load(`schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519
    sites:
      - host: git.company.com
        alsoRoutes: [company.com]
        alias: work
rules: []
`);
  const body = renderIdentityConfig(profiles, 'work', { aliasFor: (n) => aliasesForIdentity(profiles, n) });
  assert.match(body, /insteadOf = git@company\.com:/);
  assert.match(body, /insteadOf = https:\/\/company\.com\//);
});

test('a custom port gets its own ssh:// prefix so it is not swallowed into the path', () => {
  const profiles = load(`schemaVersion: 1
identities:
  work:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519
    sites:
      - host: git.company.com
        port: 9092
        alias: work
rules: []
`);
  const body = renderIdentityConfig(profiles, 'work', { aliasFor: (n) => aliasesForIdentity(profiles, n) });
  const lines = body.split('\n').map((l) => l.trim());
  const portIndex = lines.indexOf('insteadOf = ssh://git@git.company.com:9092/');
  const bareIndex = lines.indexOf('insteadOf = ssh://git@git.company.com/');
  assert.ok(portIndex >= 0, 'port-specific prefix emitted');
  assert.ok(bareIndex >= 0, 'bare prefix still emitted');
  assert.ok(portIndex < bareIndex, 'the port-specific prefix must come first');
  assert.ok(!lines.includes('insteadOf = ssh://git@git.company.com:'), 'no prefix that ends at the colon');
});

test('default port 22 does not emit a redundant prefix', () => {
  const profiles = load(`schemaVersion: 1
identities:
  gh:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        port: 22
        alias: gh
rules: []
`);
  const body = renderIdentityConfig(profiles, 'gh', { aliasFor: (n) => aliasesForIdentity(profiles, n) });
  assert.ok(!body.includes(':22/'));
});

test('ssh hosts always carry IdentitiesOnly yes and the right key', () => {
  const profiles = load(PROFILE);
  const hosts = buildHosts(profiles);
  assert.equal(hosts.length, 2);
  const block = renderSshBlock(hosts);
  assert.match(block, /Host gh\n\tHostName github\.com\n\tUser git\n\tIdentityFile ~\/\.ssh\/id_ed25519_github\n\tIdentitiesOnly yes/);
  assert.match(block, /Host work\n\tHostName git\.company\.example\n\tPort 9092\n\tUser git/);
  assert.equal(block.match(/IdentitiesOnly yes/g)?.length, 2);
});

test('we never emit a bare Host entry for the real host', () => {
  const profiles = load(PROFILE);
  const block = renderSshBlock(buildHosts(profiles));
  assert.ok(!/^Host github\.com$/m.test(block));
  assert.ok(!/^Host gitee\.com$/m.test(block));
});

test('a site without a key gets no Host block', () => {
  const profiles = parseProfilesText(
    `schemaVersion: 1
identities:
  keyed:
    user:
      name: a
      email: a@example.com
    sshKey: id_ed25519
    sites:
      - host: github.com
        alias: gh
  keyless:
    user:
      name: b
      email: b@example.com
    sites:
      - host: gitee.com
        alias: gitee
rules: []
`,
    HOME,
  );

  const { hosts, skipped } = buildHostsDetailed(profiles);
  assert.equal(hosts.length, 1, 'only the keyed site is rendered');
  assert.equal(hosts[0]?.alias, 'gh');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.host, 'gitee.com');

  const block = renderSshBlock(hosts);
  assert.ok(!block.includes('Host gitee'), block);
  // every emitted block must pin a key: IdentitiesOnly without IdentityFile
  // would fall back to ssh's default keys
  for (const chunk of block.split('\n\n')) {
    assert.match(chunk, /IdentityFile /, `a Host block without IdentityFile: ${chunk}`);
  }
});

test('a keyless site is not routed through insteadOf either', () => {
  const profiles = parseProfilesText(
    `schemaVersion: 1
identities:
  keyless:
    user:
      name: b
      email: b@example.com
    sites:
      - host: gitee.com
        alias: gitee
rules: []
`,
    HOME,
  );
  // routing to an alias whose Host block was never generated would fail
  assert.deepEqual(aliasesForIdentity(profiles, 'keyless'), []);
  const body = renderIdentityConfig(profiles, 'keyless', { aliasFor: (n) => aliasesForIdentity(profiles, n) });
  assert.ok(!body.includes('insteadOf'), body);
});

test('plan warns about each site skipped for lack of a key', async () => {
  const h = await createTmpHome();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');
    const profiles = parseProfilesText(
      `schemaVersion: 1
identities:
  keyless:
    user:
      name: b
      email: b@example.com
    sites:
      - host: gitee.com
rules: []
`,
      h.home,
    );
    const p = await plan({ home: h.home, profiles });
    assert.ok(
      p.warnings.some((w) => /no SSH key for identity "keyless"/.test(w)),
      p.warnings.join('; '),
    );
  } finally {
    await h.cleanup();
  }
});

test('conflicting includeIf targets for one directory are rejected by the renderer', () => {
  // The model rejects duplicate rules, so build the conflicting set directly:
  // the renderer must still refuse rather than silently emit one of them.
  const profiles = load(PROFILE);
  profiles.rules.push({ dir: `${HOME}/code/personal`, identity: 'work' });
  assert.throws(
    () =>
      renderIncludeIfBlock(profiles, {
        identityConfigPath: (id) => `/x/${id}.gitconfig`,
        contract: (p) => p,
      }),
    /conflicting includeIf targets/,
  );
});
