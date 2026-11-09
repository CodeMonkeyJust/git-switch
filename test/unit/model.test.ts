import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelError, fromYaml, resolveIdentity, type Profiles } from '../../src/core/model.ts';
import { parse } from '../../src/core/yaml.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';

const HOME = '/home/tester';

function load(yamlText: string): Profiles {
  return parseProfilesText(yamlText, HOME);
}

function profile(rules: string, identityExtra = ''): string {
  const body = rules.trim() === 'EMPTY' ? 'rules: []\n' : `rules:\n${rules}`;
  return `schemaVersion: 1
identities:
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
${body}`.replace('      email: zhulj@pde.com.cn\n', `      email: zhulj@pde.com.cn\n${identityExtra}`);
}

test('rejects passwords, tokens and private keys in profiles.yaml', () => {
  assert.throws(
    () =>
      load(`schemaVersion: 1
identities:
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    password: hunter2
rules: []
`),
    /must not contain secrets/,
  );
  assert.throws(
    () => load(profile('EMPTY', '  token: abc123\n')),
    /must not contain secrets/,
  );
  assert.throws(
    () => load(profile('EMPTY', '  comment: "-----BEGIN OPENSSH PRIVATE KEY-----"\n')),
    /private key material/,
  );
});

test('rejects an unknown schemaVersion instead of guessing', () => {
  assert.throws(
    () => load(profile('EMPTY').replace('schemaVersion: 1', 'schemaVersion: 99')),
    /unsupported schemaVersion/,
  );
});

test('requires schemaVersion', () => {
  assert.throws(
    () => load(profile('EMPTY').replace('schemaVersion: 1\n', '')),
    /missing schemaVersion/,
  );
});

test('rejects an unknown identity referenced by a rule', () => {
  assert.throws(
    () => load(profile(`  - dir: ${HOME}/x\n    identity: ghost\n`)),
    /unknown identity "ghost"/,
  );
});

test('rejects duplicate directory rules', () => {
  assert.throws(
    () => load(profile(`  - dir: ${HOME}/x\n    identity: personal\n  - dir: ${HOME}/x\n    identity: personal\n`)),
    /mapped twice/,
  );
});

test('longest matching directory rule wins', () => {
  const profiles = load(
    profile(`  - dir: ${HOME}/code
    identity: personal
  - dir: ${HOME}/code/work
    identity: work
  - dir: ${HOME}/code/work/special
    identity: personal
`),
  );
  assert.equal(profiles.rules[0]?.dir, `${HOME}/code/work/special`);
  assert.equal(profiles.rules[2]?.dir, `${HOME}/code`);
  const res = resolveIdentity(profiles, '/home/tester/code/work/sub/dir');
  assert.equal(res?.detail, `directory rule ${HOME}/code/work`);
  assert.equal(res?.identity.name, 'work');
});

test('a repo override beats a directory rule', () => {
  const profiles = load(
    profile(
      `  - dir: ${HOME}/code\n    identity: personal\n`,
      `repositories:\n  - path: ${HOME}/code/special\n    identity: work\n`,
    ),
  );
  assert.equal(resolveIdentity(profiles, `${HOME}/code/special`)?.reason, 'repo');
  assert.equal(resolveIdentity(profiles, `${HOME}/code/other`)?.reason, 'rule');
});

test('rule matching is case sensitive and prefix-safe', () => {
  const profiles = load(profile(`  - dir: ${HOME}/code/github\n    identity: personal\n`));
  // git's `gitdir:` is case sensitive, so gs must be too: reporting a match that
  // git would not honour is worse than reporting none.
  assert.ok(resolveIdentity(profiles, `${HOME}/code/github/repo`));
  assert.equal(resolveIdentity(profiles, `${HOME}/code/GitHub/repo`), undefined);
  assert.equal(resolveIdentity(profiles, `${HOME}/code/githubx/repo`), undefined, 'no partial segment match');
});

test('backslashes in rule dirs are normalised to forward slashes', () => {
  const profiles = load(profile(`  - dir: ${HOME}\\code\\x\n    identity: personal\n`));
  assert.equal(profiles.rules[0]?.dir, `${HOME}/code/x`);
});

test('duplicate sites for the same host are rejected', () => {
  const text = `schemaVersion: 1
identities:
  a:
    user: { name: A, email: a@example.com }
    sites:
      - host: github.com
      - host: github.com
`;
  assert.throws(() => load(text), /duplicate site/);
});

test('yaml parser handles nested lists of mappings', () => {
  const doc = parse(`
schemaVersion: 1
identities:
  p:
    sites:
      - host: github.com
        port: 22
      - host: gitee.com
        alias: g
rules:
  - dir: /a
    identity: p
`);
  assert.deepEqual(doc.identities, {
    p: { sites: [{ host: 'github.com', port: 22 }, { host: 'gitee.com', alias: 'g' }] },
  });
});

test('yaml parser supports inline flow mappings', () => {
  const doc = parse(`user: { name: A, email: a@example.com }`);
  assert.deepEqual(doc.user, { name: 'A', email: 'a@example.com' });
});

test('yaml parser rejects tabs for indentation', () => {
  assert.throws(() => parse('a:\n\tb: 1\n'), /tabs are not allowed/);
});

export { ModelError, fromYaml };


