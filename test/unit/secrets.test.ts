import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoSecrets, ModelError } from '../../src/core/model.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';

/**
 * profiles.yaml is committed to dotfile repositories and shared through
 * snapshots, so the secret guard is the only thing standing between a careless
 * paste and a leaked credential. These cases are the ones that actually appear
 * in the wild.
 */

const HOME = '/home/tester';

function blocked(value: unknown): boolean {
  try {
    assertNoSecrets(value as never);
    return false;
  } catch (err) {
    assert.ok(err instanceof ModelError);
    return true;
  }
}

const MUST_BLOCK: [string, Record<string, unknown>][] = [
  ['password', { password: 'hunter2' }],
  ['PASSWORD in caps', { PASSWORD: 'hunter2' }],
  ['api_secret', { api_secret: 'x' }],
  ['github_token', { github_token: 'x' }],
  ['myPassword (camelCase)', { myPassword: 'x' }],
  ['apiToken (camelCase)', { apiToken: 'x' }],
  ['clientSecret (camelCase)', { clientSecret: 'x' }],
  ['passphrase', { passphrase: 'x' }],
  ['private_key', { private_key: 'x' }],
  ['accessKey', { accessKey: 'x' }],
  ['credential', { credential: 'x' }],
  ['token prefixed', { token_count: 5 }],
];

const MUST_PASS: [string, Record<string, unknown>][] = [
  ['an email', { email: 'a@example.com' }],
  ['a host', { host: 'github.com' }],
  ['a key file name', { sshKey: 'id_ed25519' }],
  ['a directory', { dir: '/code/work' }],
  ['an alias', { alias: 'pde' }],
  ['a user name', { name: 'zhulj' }],
  ['a ssh user', { user: 'git' }],
  ['a comment mentioning secret', { comment: 'my secret santa folder' }],
];

for (const [label, value] of MUST_BLOCK) {
  test(`a profile key holding ${label} is refused`, () => {
    assert.equal(blocked(value), true, `${JSON.stringify(value)} should be rejected`);
  });
}

for (const [label, value] of MUST_PASS) {
  test(`${label} is accepted`, () => {
    assert.equal(blocked(value), false, `${JSON.stringify(value)} should be allowed`);
  });
}

const MUST_BLOCK_VALUES: [string, string][] = [
  ['an OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----'],
  ['an RSA private key header', '-----BEGIN RSA PRIVATE KEY-----'],
  ['a PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['a bearer token', 'Authorization: Bearer abcdefghij1234567890'],
  ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a GitLab token', 'glpat-abcdefghij1234567890'],
  ['a Slack token', 'xoxb-1234567890-abcdefghij'],
  ['an OpenAI style key', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
];

for (const [label, value] of MUST_BLOCK_VALUES) {
  test(`a value that looks like ${label} is refused`, () => {
    assert.equal(blocked({ note: value }), true, value);
  });
}

test('the guard inspects nested structures and lists', () => {
  assert.equal(blocked({ identities: { a: { user: { password: 'x' } } } }), true);
  assert.equal(blocked({ rules: [{ dir: '/x', github_token: 'y' }] }), true);
  assert.equal(blocked({ rules: [{ dir: '/x', identity: 'work' }] }), false);
});

test('a credential pasted into a profile file is refused by the loader', () => {
  // end to end: the error must reach the user, not just the internal guard
  assert.throws(
    () =>
      parseProfilesText(
        `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@example.com
      password: hunter2
rules: []
`,
        HOME,
      ),
    /must not contain secrets/,
  );
});

test('a token value pasted as a comment is refused by the loader', () => {
  assert.throws(
    () =>
      parseProfilesText(
        `schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@example.com
rules:
  - dir: /code
    identity: work
    comment: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
`,
        HOME,
      ),
    /looks like a GitHub token/,
  );
});
