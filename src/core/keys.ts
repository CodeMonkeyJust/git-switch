/**
 * SSH key management.
 *
 * `gs` never copies or stores private key material — it lists, generates and
 * copies *public* keys, and reports the fingerprint of private ones. That is the
 * whole point: keys stay where ssh expects them, under ~/.ssh.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Profiles } from './model.ts';
import { exists } from '../util/fs-atomic.ts';

const run = promisify(execFile);

export interface KeyInfo {
  name: string;
  path: string;
  /** key type as reported by ssh-keygen, e.g. ED25519 */
  type?: string;
  /** SHA256:... */
  fingerprint?: string;
  comment?: string;
  hasPublic: boolean;
  /** identities in the profile that reference this key */
  usedBy: string[];
  error?: string;
}

export interface ListKeysOptions {
  home: string;
  profiles?: Profiles;
}

const KEY_NAME = /^[A-Za-z0-9._-]+$/;

/** Private key files in ~/.ssh that are not obviously something else. */
export async function listPrivateKeys(home: string): Promise<string[]> {
  const dir = path.join(home, '.ssh');
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith('.pub') || name.startsWith('.')) continue;
    if (name === 'config' || name === 'known_hosts' || name === 'known_hosts.old') continue;
    if (!KEY_NAME.test(name)) continue;
    const content = await readFile(path.join(dir, name), 'utf8').catch(() => '');
    if (content.includes('PRIVATE KEY')) names.push(name);
  }
  return names.sort();
}

export async function keyFingerprint(file: string): Promise<{ type?: string; fingerprint?: string; comment?: string }> {
  try {
    const { stdout } = await run('ssh-keygen', ['-l', '-f', file]);
    // "256 SHA256:abc... comment (ED25519)"
    const match = /^\d+\s+(SHA256:\S+)\s*(.*?)\s*\(([^)]+)\)\s*$/.exec(stdout.trim());
    if (!match) return {};
    const result: { type?: string; fingerprint?: string; comment?: string } = {
      fingerprint: match[1] as string,
      type: match[3] as string,
    };
    const comment = (match[2] ?? '').trim();
    if (comment) result.comment = comment;
    return result;
  } catch {
    return {};
  }
}

export async function listKeys(opts: ListKeysOptions): Promise<KeyInfo[]> {
  const names = await listPrivateKeys(opts.home);
  const results: KeyInfo[] = [];

  for (const name of names) {
    const file = path.join(opts.home, '.ssh', name);
    const info = await keyFingerprint(file);
    const usedBy =
      opts.profiles?.identities
        .filter((i) => i.sshKey === name)
        .map((i) => i.name) ?? [];
    const entry: KeyInfo = {
      name,
      path: file,
      hasPublic: await exists(`${file}.pub`),
      usedBy,
    };
    if (info.type) entry.type = info.type;
    if (info.fingerprint) entry.fingerprint = info.fingerprint;
    if (info.comment) entry.comment = info.comment;
    results.push(entry);
  }

  return results;
}

export interface GenerateOptions {
  home: string;
  name: string;
  type?: 'ed25519' | 'rsa';
  comment?: string;
}

export interface GenerateResult {
  path: string;
  publicKey: string;
  fingerprint?: string;
}

/**
 * Create a new key pair. Refuses to overwrite an existing key rather than
 * offering a confusing ssh-keygen prompt.
 */
export async function generateKey(opts: GenerateOptions): Promise<GenerateResult> {
  if (!KEY_NAME.test(opts.name)) {
    throw new Error(`invalid key name "${opts.name}": use letters, digits, dot, dash or underscore`);
  }
  const dir = path.join(opts.home, '.ssh');
  const file = path.join(dir, opts.name);
  if (await exists(file)) {
    throw new Error(`${file} already exists; refusing to overwrite`);
  }
  // ssh-keygen fails with ENOENT when ~/.ssh does not exist yet (fresh machine)
  await mkdir(dir, { recursive: true });

  const type = opts.type ?? 'ed25519';
  const args = ['-t', type, '-f', file, '-N', '', '-q'];
  if (type === 'rsa') args.push('-b', '4096');
  if (opts.comment) args.push('-C', opts.comment);

  await run('ssh-keygen', args);
  const publicKey = (await readFile(`${file}.pub`, 'utf8')).trim();
  const fp = await keyFingerprint(file);
  const result: GenerateResult = { path: file, publicKey };
  if (fp.fingerprint) result.fingerprint = fp.fingerprint;
  return result;
}

/** The public key text for an existing key, for pasting into a forge. */
export async function publicKeyFor(home: string, name: string): Promise<string> {
  if (!KEY_NAME.test(name)) throw new Error(`invalid key name "${name}"`);
  const file = path.join(home, '.ssh', name);
  if (!(await exists(file))) throw new Error(`${name} does not exist in ~/.ssh`);
  const pubPath = `${file}.pub`;
  if (await exists(pubPath)) return (await readFile(pubPath, 'utf8')).trim();
  // derive it when only the private key is present
  const { stdout } = await run('ssh-keygen', ['-y', '-f', file]);
  return stdout.trim();
}

/** Best-effort clipboard copy across platforms. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const platform = process.platform;
  const candidates: [string, string[]][] =
    platform === 'win32'
      ? [['clip', []]]
      : platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  for (const [command, args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin?.end(text);
      });
      return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}
