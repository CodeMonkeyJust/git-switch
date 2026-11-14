/**
 * Live smoke test for the GUI feature-parity endpoints: keys, snapshots, setup
 * and the language switch. Runs against a throw-away home and prints results.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/http.ts';
import { generateKey } from '../src/core/keys.ts';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const home = await mkdtemp(path.join(tmpdir(), 'gs-parity-'));
await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
await writeFile(
  path.join(home, '.config', 'gs', 'profiles.yaml'),
  `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@example.com
    sshKey: id_work
    sites:
      - host: git.example.com
        port: 9092
        alias: pde
rules:
  - dir: /code/work
    identity: work
`,
  'utf8',
);
await writeFile(path.join(home, '.gitconfig'), '', 'utf8');
await generateKey({ home, name: 'id_work' });

const server = await startServer({ home });
const base = `http://127.0.0.1:${server.port}`;
const auth = { 'x-gs-token': server.token };
const json = { ...auth, 'content-type': 'application/json' };
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: json, body: JSON.stringify(body ?? {}) });

try {
  /* ---- keys ---- */
  const keys = await (await fetch(`${base}/api/keys`, { headers: auth })).json();
  check('GET /api/keys lists the key', keys.keys.some((k) => k.name === 'id_work'));
  check('no private key material in the payload', !JSON.stringify(keys).includes('PRIVATE KEY'));
  check('the key reports the identity using it', keys.keys[0]?.usedBy?.includes('work'));

  const copy = await (await post('/api/keys', { action: 'copy', name: 'id_work' })).json();
  check('copy returns a public key or clipboard success', Boolean(copy.copied) || Boolean(copy.publicKey));

  const gen = await post('/api/keys', { action: 'generate', name: 'id_new', comment: 'x@example.com' });
  check('generate creates a key', gen.status === 200, `status ${gen.status}`);
  check(
    'the new key exists on disk',
    await readFile(path.join(home, '.ssh', 'id_new'), 'utf8')
      .then((c) => c.includes('PRIVATE KEY'))
      .catch(() => false),
  );

  /* ---- snapshot export / import ---- */
  const snapPath = path.join(home, 'out.gsnap');
  const exported = await (
    await post('/api/snapshot/export', { path: snapPath, withKeys: true, passphrase: 'test-pass-123' })
  ).json();
  check('export reports a path', typeof exported.path === 'string' && exported.path !== '', JSON.stringify(exported));
  const sealed = await readFile(snapPath, 'utf8').catch(() => '');
  check('the snapshot is encrypted', sealed.includes('"magic"') && !sealed.includes('PRIVATE KEY'));

  const imported = await post('/api/snapshot/import', {
    path: snapPath,
    passphrase: 'test-pass-123',
    remaps: '/code/work=/srv/work',
  });
  check('import succeeds', imported.status === 200, `status ${imported.status}`);
  const afterImport = await readFile(path.join(home, '.config', 'gs', 'profiles.yaml'), 'utf8');
  check('the remap was applied', afterImport.includes('/srv/work'));

  /* ---- state carries language + messages ---- */
  const zh = await (await fetch(`${base}/api/state?lang=zh-CN`, { headers: auth })).json();
  check('state switches language', zh.language === 'zh-CN');
  check('state carries the chinese catalogue', zh.messages['web.tab.keys'] === '密钥', zh.messages['web.tab.keys']);
  check('state reports profileExists', zh.profileExists === true);

  const en = await (await fetch(`${base}/api/state?lang=en`, { headers: auth })).json();
  check('state switches back to english', en.messages['web.tab.keys'] === 'Keys');

  /* ---- init ---- */
  const scan = await (await post('/api/init/scan', { root: home, offline: true })).json();
  check('init scan returns identities and rules', Array.isArray(scan.identities) && Array.isArray(scan.rules));
  const blocked = await post('/api/init/apply', { root: home, offline: true });
  check('init apply refuses an existing profile', blocked.status === 409, `status ${blocked.status}`);
} finally {
  await server.close();
  await rm(home, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all parity checks passed');
}
