/**
 * Manual smoke test for the GUI server.
 *
 * Starts the real server against a throw-away home, exercises every endpoint
 * (including the security checks), prints a summary and exits non-zero on
 * failure. Run with: node scripts/smoke-gui.mjs
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/server/http.ts';

const home = await mkdtemp(path.join(tmpdir(), 'gs-gui-smoke-'));
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function main() {
  // a real-looking profile in the throw-away home
  await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  await mkdir(path.join(home, 'code', 'work'), { recursive: true });
  const posix = (p) => p.replace(/\\/g, '/');

  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(home, '.config', 'gs', 'profiles.yaml'),
    `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sshKey: id_ed25519
    sites:
      - host: git.company.example
        port: 9092
        alias: pde
rules:
  - dir: ${posix(home)}/code/work
    identity: work
settings:
  backupKeep: 5
`,
    'utf8',
  );
  await writeFile(path.join(home, '.gitconfig'), '', 'utf8');

  const server = await startServer({ home });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { 'x-gs-token': server.token };

  try {
    // --- static ---
    const index = await fetch(`${base}/`, { headers: auth });
    check('serves index.html', index.status === 200);
    check(
      'sends a strict CSP',
      (index.headers.get('content-security-policy') ?? '').includes("default-src 'self'"),
    );

    const js = await fetch(`${base}/src/main.js`, { headers: auth });
    check('serves the app module', js.status === 200);

    // --- security ---
    const noToken = await fetch(`${base}/api/state`);
    check('rejects a missing token', noToken.status === 401);

    const badToken = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': 'wrong' } });
    check('rejects a wrong token', badToken.status === 401);

    const badOrigin = await fetch(`${base}/api/state`, {
      headers: { ...auth, origin: 'http://evil.example' },
    });
    check('rejects a cross-origin request', badOrigin.status === 403);

    const goodOrigin = await fetch(`${base}/api/state`, {
      headers: { ...auth, origin: base },
    });
    check('accepts a same-origin request', goodOrigin.status === 200);

    // Host header spoofing (DNS rebinding).
    // `fetch` refuses to override Host (it is a forbidden header), so this has to
    // go through a raw HTTP request to actually exercise the server-side check.
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/state',
          headers: { host: `evil.example:${server.port}`, 'x-gs-token': server.token },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    check('rejects an invalid Host header (DNS rebinding)', reboundStatus === 403, `got ${reboundStatus}`);

    // --- api ---
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    check('state lists identities', state.identities?.length === 1);
    check('state lists rules', state.rules?.length === 1);
    check('state exposes no private key material', !JSON.stringify(state).includes('PRIVATE KEY'));

    const planRes = await fetch(`${base}/api/plan`, { method: 'POST', headers: auth });
    const plan = await planRes.json();
    check('plan is dirty before apply', plan.dirty === true);
    check('plan contains a diff', (plan.files ?? []).some((f) => f.diff?.includes('gs:managed')));

    const doctor = await (await fetch(`${base}/api/doctor`, { headers: auth })).json();
    check('doctor reports a missing key as an error', doctor.errors >= 1);

    const fs = await (await fetch(`${base}/api/fs`, { headers: auth })).json();
    check('fs browse lists directories', Array.isArray(fs.entries));

    const traversal = await (
      await fetch(`${base}/api/fs?dir=${encodeURIComponent('/etc/../etc')}`, { headers: auth })
    ).json();
    check('fs browse rejects traversal', Boolean(traversal.error));

    // --- apply ---
    const applied = await (await fetch(`${base}/api/apply`, { method: 'POST', headers: auth })).json();
    check('apply writes files', applied.written?.length > 0, JSON.stringify(applied));

    const plan2 = await (await fetch(`${base}/api/plan`, { method: 'POST', headers: auth })).json();
    check('apply is idempotent', plan2.dirty === false);

    // --- rules mutation ---
    const added = await (
      await fetch(`${base}/api/rules`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ add: true, dir: `${posix(home)}/code/other`, identity: 'work' }),
      })
    ).json();
    check('adding a rule persists', added.rules?.length === 2);

    const removed = await (
      await fetch(`${base}/api/rules`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ remove: `${posix(home)}/code/other` }),
      })
    ).json();
    check('removing a rule persists', removed.rules?.length === 1);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('all GUI smoke checks passed');
  }
}

await main();
