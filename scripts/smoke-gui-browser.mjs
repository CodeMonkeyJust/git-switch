/**
 * Simulate what a real browser does when it opens `gs gui`:
 *
 *   1. GET /                     <- NO token (the fragment is never sent)
 *   2. GET /src/main.js, …       <- NO token (ES module imports carry no header)
 *   3. GET /api/state            <- token from location.hash, as x-gs-token
 *
 * Run with: node scripts/smoke-gui-browser.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/http.ts';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const home = await mkdtemp(path.join(tmpdir(), 'gs-browser-'));
await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
await writeFile(
  path.join(home, '.config', 'gs', 'profiles.yaml'),
  'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules: []\n',
  'utf8',
);

const server = await startServer({ home });
const base = `http://127.0.0.1:${server.port}`;
const token = server.url.split('token=')[1];

try {
  // 1. the first navigation has no way to send the fragment
  const page = await fetch(`${base}/`);
  check('GET / without a token loads the page', page.status === 200, `status ${page.status}`);
  const html = await page.text();
  check('the page is the real UI', /data-view="overview"/.test(html));
  check('no token leaked into the served HTML', !html.includes(token));

  // 2. module imports carry no custom headers in a browser
  for (const asset of ['/src/main.js', '/src/api.js', '/src/styles/main.css', '/src/views/overview.js']) {
    const res = await fetch(`${base}${asset}`);
    check(`GET ${asset} without a token`, res.status === 200, `status ${res.status}`);
  }

  // 3. the API still demands the token
  const noToken = await fetch(`${base}/api/state`);
  check('GET /api/state without a token is refused', noToken.status === 401, `status ${noToken.status}`);

  const api = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } });
  check('GET /api/state with the token works', api.status === 200, `status ${api.status}`);

  // 4. Host / Origin stay enforced, even for static files
  const badOrigin = await fetch(`${base}/`, { headers: { origin: 'http://evil.example' } });
  check('a cross-origin page cannot load the UI', badOrigin.status === 403, `status ${badOrigin.status}`);
} finally {
  await server.close();
  await rm(home, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('browser flow verified');
}
