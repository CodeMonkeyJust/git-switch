#!/usr/bin/env node
/**
 * Test runner with a floor.
 *
 * `node --test <glob>` exits 0 with "tests 0" when the glob matches nothing, so
 * CI would go green on a checkout where the tests were accidentally not present.
 * This wrapper runs the suite and fails if the reported test count is below a
 * minimum, keeping the gate honest.
 */

import { spawn } from 'node:child_process';

const MIN_TESTS = Number.parseInt(process.env.GS_MIN_TESTS ?? '261', 10);
const patterns = process.argv.slice(2);

if (patterns.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <glob> [glob...]');
  process.exit(2);
}

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--test', ...patterns],
  { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
);

let buffer = '';
const forward = (chunk) => {
  buffer += chunk.toString();
  process.stdout.write(chunk);
};
child.stdout.on('data', forward);

child.on('close', (code) => {
  const match = /# tests (\d+)/.exec(buffer) ?? /tests (\d+)/.exec(buffer);
  const total = match ? Number.parseInt(match[1], 10) : 0;

  if (code !== 0) {
    process.exit(code ?? 1);
  }
  if (total < MIN_TESTS) {
    console.error(
      `\ntest floor not met: ran ${total} tests, expected at least ${MIN_TESTS}. ` +
        `If the suite legitimately shrank, lower GS_MIN_TESTS explicitly.`,
    );
    process.exit(1);
  }
  console.log(`\ntest floor satisfied: ${total} tests (minimum ${MIN_TESTS})`);
});
