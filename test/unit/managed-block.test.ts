import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEGIN_MARKER,
  END_MARKER,
  BlockError,
  contentHash,
  detectEol,
  findBlock,
  upsertBlock,
} from '../../src/core/managed-block.ts';

const body = 'Host a\n\tHostName a.com';

test('appends a block to an empty file', () => {
  const out = upsertBlock('', body);
  assert.equal(out, `${BEGIN_MARKER}\n${body}\n${END_MARKER}\n`);
});

test('appends a block after existing content with a blank separator', () => {
  const out = upsertBlock('Host old\n\tHostName old.com\n', body);
  assert.ok(out.startsWith('Host old\n\tHostName old.com\n\n'));
  assert.ok(out.includes(BEGIN_MARKER));
});

test('replaces an existing block in place', () => {
  const first = upsertBlock('user = me\n', body);
  const second = upsertBlock(first, 'Host b\n\tHostName b.com');
  assert.ok(second.startsWith('user = me\n'));
  const block = findBlock(second);
  assert.ok(block.present);
  assert.equal(block.content.trimEnd(), 'Host b\n\tHostName b.com');
  assert.equal(second.match(/gs:managed >>>/g)?.length, 1);
});

test('upsert is idempotent', () => {
  const once = upsertBlock('# mine\n', body);
  assert.equal(upsertBlock(once, body), once);
});

test('preserves CRLF line endings', () => {
  const original = 'Host old\r\n\tHostName old.com\r\n';
  const out = upsertBlock(original, 'Host a\n\tHostName a.com');
  assert.equal(detectEol(out), '\r\n');
  assert.ok(!/(?<!\r)\n/.test(out), 'every LF must be preceded by CR');
  assert.ok(out.startsWith('Host old\r\n\tHostName old.com\r\n'));
});

test('content outside the block is byte-for-byte preserved', () => {
  const foreign = '# keep me\r\nHost x\r\n\tIdentityFile ~/.ssh/x\r\n# trailing comment\r\n';
  const out = upsertBlock(foreign, body);
  const block = findBlock(out);
  const before = out.slice(0, block.start);
  const after = out.slice(block.end);
  assert.ok(foreign.startsWith(before.replace(/\r?\n$/, '')));
  assert.equal(after, '');
});

test('an empty body removes the block and its separator', () => {
  const foreign = 'Host old\n\tHostName old.com\n';
  const withBlock = upsertBlock(foreign, body);
  const removed = upsertBlock(withBlock, null);
  assert.equal(removed, foreign);
});

test('duplicate markers are rejected rather than guessed', () => {
  const twice = `${BEGIN_MARKER}\nx\n${END_MARKER}\n${BEGIN_MARKER}\ny\n${END_MARKER}\n`;
  assert.throws(() => findBlock(twice), BlockError);
});

test('an orphaned BEGIN marker is rejected', () => {
  assert.throws(() => findBlock(`${BEGIN_MARKER}\nx\n`), BlockError);
});

test('an END marker without BEGIN is rejected', () => {
  assert.throws(() => findBlock(`${END_MARKER}\n`), BlockError);
});

test('contentHash is stable and changes with content', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.match(contentHash('abc'), /^[0-9a-f]{8}$/);
});
