/**
 * Verify that `gs gui` reports which home it operates on.
 *
 * A GUI started with --home used to look identical to the real one, so a user
 * could configure an identity in a sandbox and be confused when their real
 * ~/.ssh never changed. Both the console and /api/state must say which home is
 * in play.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server/http.ts';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const home = await mkdtemp(path.join(tmpdir(), 'gs-homes-'));
await mkdir(path.join(home, '.config', 'gs'), { recursive: true });
await writeFile(
  path.join(home, '.config', 'gs', 'profiles.yaml'),
  'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules: []\n',
  'utf8',
);

/* ---- API reports the sandbox ---- */
{
  const server = await startServer({ home });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const state = await (
      await fetch(`${base}/api/state`, { headers: { 'x-gs-token': server.token } })
    ).json();
    check('state marks a --home instance as sandbox', state.isSandbox === true, `isSandbox=${state.isSandbox}`);
    check('state reports the operated home', state.homePath === home.replace(/\\/g, '/'), state.homePath);
    check('state reports the real home', typeof state.realHome === 'string' && state.realHome !== '', state.realHome);
  } finally {
    await server.close();
  }
}

/* ---- API reports the real home when none is given ---- */
{
  const server = await startServer({ home: homedir() });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': server.token } });
    // the real home may not have a profile; either way isSandbox must be false
    if (res.status === 200) {
      const state = await res.json();
      check('state does not mark the real home as sandbox', state.isSandbox === false);
    } else {
      check('real home responds (no profile is acceptable)', res.status === 400, `status ${res.status}`);
    }
  } finally {
    await server.close();
  }
}

/* ---- the CLI prints the sandbox warning ---- */
{
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'src', 'cli.ts'), 'gui', '--home', home, '--no-open', '--json', '--idle-timeout', '0'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  const output = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no url: ${buffer}`));
    }, 20000);
    child.stdout.on('data', (c) => {
      buffer += c.toString();
      if (buffer.includes('"url"')) {
        clearTimeout(timer);
        child.kill();
        resolve(buffer);
      }
    });
    child.on('error', reject);
  });

  check('the JSON says which home is used', /"home":/.test(output), output.slice(0, 120));
  check('the JSON flags a sandbox', /"sandbox":\s*true/.test(output), output.slice(0, 200));
}

await rm(home, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('home reporting verified');
}
