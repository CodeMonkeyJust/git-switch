import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { hostIsAllowed, originIsAllowed, tokenMatches, createToken } from '../../src/server/auth.ts';
import { browse } from '../../src/server/fs-browse.ts';

const posix = (p: string) => p.replace(/\\/g, '/');

async function withServer(fn: (ctx: { home: string; server: RunningServer; base: string; auth: Record<string, string> }) => Promise<void>) {
  const h = await createTmpHome();
  try {
    await h.write(
      '.config/gs/profiles.yaml',
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
        alias: pde
rules:
  - dir: ${posix(h.home)}/code/work
    identity: work
`,
    );
    await h.write('.gitconfig', '');
    await mkdir(path.join(h.home, 'code', 'work'), { recursive: true });

    const server = await startServer({ home: h.home });
    try {
      await fn({ home: h.home, server, base: `http://127.0.0.1:${server.port}`, auth: { 'x-gs-token': server.token } });
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

/* ---------------- unit-level auth ---------------- */

test('tokenMatches requires an exact token', () => {
  const token = createToken();
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, token + 'x'), false);
  assert.equal(tokenMatches(token, ''), false);
  assert.equal(tokenMatches(token, undefined), false);
  assert.ok(token.length >= 32);
});

test('hostIsAllowed accepts loopback only', () => {
  assert.equal(hostIsAllowed('127.0.0.1:5000', 5000), true);
  assert.equal(hostIsAllowed('localhost:5000', 5000), true);
  assert.equal(hostIsAllowed('127.0.0.1:5001', 5000), false);
  assert.equal(hostIsAllowed('evil.example:5000', 5000), false);
  assert.equal(hostIsAllowed(undefined, 5000), false);
});

test('originIsAllowed accepts same-origin and absent origin only', () => {
  assert.equal(originIsAllowed(undefined, 5000), true);
  assert.equal(originIsAllowed('http://127.0.0.1:5000', 5000), true);
  assert.equal(originIsAllowed('http://evil.example', 5000), false);
  assert.equal(originIsAllowed('http://127.0.0.1:6000', 5000), false);
});

/* ---------------- filesystem browsing ---------------- */

test('browse refuses directories outside the allowed roots', async () => {
  const h = await createTmpHome();
  try {
    const result = await browse({ home: h.home, allowRoots: [], dir: '/' });
    assert.ok(result.error, 'root must be rejected');
    assert.match(result.error, /outside the allowed roots/);
  } finally {
    await h.cleanup();
  }
});

test('browse rejects ".." outright', async () => {
  const h = await createTmpHome();
  try {
    const result = await browse({ home: h.home, allowRoots: [], dir: `${h.home}/..` });
    assert.match(result.error ?? '', /must not contain ".."/);
  } finally {
    await h.cleanup();
  }
});

test('browse lists directories and marks repositories', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, 'proj', 'repo', '.git'), { recursive: true });
    await mkdir(path.join(h.home, 'proj', 'plain'), { recursive: true });
    const result = await browse({ home: h.home, allowRoots: [], dir: path.join(h.home, 'proj') });
    assert.equal(result.entries.length, 2);
    assert.ok(result.entries.some((e) => e.name === 'repo' && e.isRepo));
    assert.ok(result.entries.some((e) => e.name === 'plain' && !e.isRepo));
  } finally {
    await h.cleanup();
  }
});

/* ---------------- HTTP security ---------------- */

test('API rejects requests without a token', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 401);
  });
});

test('the page loads without a token, as a real browser first hop must', async () => {
  // The URL fragment (#token=…) is never sent to the server, so the very first
  // request for "/" cannot carry the token. Requiring it made the GUI show
  // {"error":"missing or invalid token"} instead of the app.
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, 'the index page must load without a token');
    const html = await page.text();
    assert.match(html, /data-view="overview"/);
  });
});

test('every static asset a browser imports loads without a token', async () => {
  await withServer(async ({ base }) => {
    const assets = [
      '/src/main.js',
      '/src/api.js',
      '/src/views/overview.js',
      '/src/views/rules.js',
      '/src/views/preview.js',
      '/src/views/doctor.js',
      '/src/styles/main.css',
    ];
    for (const asset of assets) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, `${asset} must be served without a token`);
    }
  });
});

test('the served HTML never contains the token', async () => {
  await withServer(async ({ base, server }) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(!html.includes(server.token), 'the token must stay in the fragment, not in the document');
  });
});

test('static files still reject a foreign Origin', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`, { headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('API rejects a cross-origin request', async () => {
  await withServer(async ({ base, auth }) => {
    const res = await fetch(`${base}/api/state`, { headers: { ...auth, origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});

test('API rejects a rebound Host header', async () => {
  await withServer(async ({ server, auth }) => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/state',
          headers: { host: `evil.example:${server.port}`, ...auth },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('static responses carry a strict CSP and no CORS header', async () => {
  await withServer(async ({ base, auth }) => {
    const res = await fetch(`${base}/`, { headers: auth });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('state never exposes private key material', async () => {
  await withServer(async ({ base, auth }) => {
    const body = await (await fetch(`${base}/api/state`, { headers: auth })).text();
    assert.ok(!body.includes('PRIVATE KEY'));
  });
});

/* ---------------- API behaviour ---------------- */

test('plan then apply is idempotent through the API', async () => {
  await withServer(async ({ base, auth }) => {
    const first = (await (await fetch(`${base}/api/plan`, { method: 'POST', headers: auth })).json()) as { dirty: boolean; files: { diff: string }[] };
    assert.equal(first.dirty, true);
    assert.ok(first.files.some((f: { diff: string }) => f.diff.includes('gs:managed')));

    const applied = (await (await fetch(`${base}/api/apply`, { method: 'POST', headers: auth })).json()) as { written: string[] };
    assert.ok(applied.written.length > 0);

    const second = (await (await fetch(`${base}/api/plan`, { method: 'POST', headers: auth })).json()) as { dirty: boolean };
    assert.equal(second.dirty, false);
  });
});

test('doctor reports the missing key as an error', async () => {
  await withServer(async ({ base, auth }) => {
    const report = (await (await fetch(`${base}/api/doctor`, { headers: auth })).json()) as { errors: number; results: { level: string; title: string }[] };
    assert.ok(report.errors >= 1);
    assert.ok(report.results.some((r: { level: string; title: string }) => r.level === 'error' && /does not exist/.test(r.title)));
  });
});

test('rules can be added and removed through the API', async () => {
  await withServer(async ({ home, base, auth }) => {
    const add = (await (await fetch(`${base}/api/rules`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ add: true, dir: `${posix(home)}/code/other`, identity: 'work' }) })).json()) as { rules: unknown[] };
    assert.equal(add.rules.length, 2);

    const remove = (await (await fetch(`${base}/api/rules`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ remove: `${posix(home)}/code/other` }) })).json()) as { rules: unknown[] };
    assert.equal(remove.rules.length, 1);
  });
});

test('adding a rule with an unknown identity is rejected', async () => {
  await withServer(async ({ home, base, auth }) => {
    const res = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ add: true, dir: `${posix(home)}/code/x`, identity: 'ghost' }),
    });
    assert.equal(res.status, 400);
  });
});
