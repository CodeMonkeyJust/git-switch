/**
 * Probe which SSH key actually authenticates a site.
 *
 * `gs init` can only see `IdentityFile` entries in ~/.ssh/config. A site that
 * relies on ssh's default key names (`id_ed25519` & co) looks "keyless" even
 * though it works — which is misleading, because `gs` would then warn about a
 * problem that does not exist. Probing resolves the truth.
 *
 * Probes are opt-in (network); `gs init` runs them unless `--offline` is given.
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../util/fs-atomic.ts';
import { DEFAULT_KEY_NAMES } from './discover.ts';

const run = promisify(execFile);

export interface ProbeOptions {
  home: string;
  host: string;
  port?: number;
  user?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  host: string;
  /** key file name under ~/.ssh that authenticated, if any */
  key?: string;
  ok: boolean;
  message: string;
}

/** Key files present under ~/.ssh, in ssh's default preference order first. */
export async function availableKeys(home: string): Promise<string[]> {
  const dir = path.join(home, '.ssh');
  if (!(await exists(dir))) return [];
  const entries: string[] = await readdir(dir).catch(() => [] as string[]);

  const defaults = DEFAULT_KEY_NAMES.filter((name: string) => entries.includes(name));
  const others = entries
    .filter((name) => !DEFAULT_KEY_NAMES.includes(name))
    .filter((name) => !name.endsWith('.pub') && name !== 'config' && name !== 'known_hosts' && name !== 'known_hosts.old' && !name.startsWith('.'))
    .filter((name) => /^[A-Za-z0-9._-]+$/.test(name));

  return [...defaults, ...others.sort()];
}

async function tryKey(opts: ProbeOptions, keyName: string, timeoutMs: number): Promise<boolean> {
  // Git hosting servers authenticate as the `git` user, not as the local account
  // name; ssh would otherwise offer `otheruser@host` and be rejected.
  const user = opts.user ?? 'git';
  const target = `${user}@${opts.host}`;
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    '-o', 'IdentitiesOnly=yes',
    '-i', path.join(opts.home, '.ssh', keyName),
  ];
  if (opts.port !== undefined) args.push('-p', String(opts.port));
  args.push(target);

  try {
    await run('ssh', args, {
      timeout: timeoutMs,
      env: { ...process.env, HOME: opts.home, USERPROFILE: opts.home },
    });
    return true;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    // Gitea/GitHub reply "does not provide shell access" with a non-zero exit on
    // some servers; a successful authentication is still visible in the banner.
    return /successfully authenticated|Hi there|You've successfully/i.test(stderr);
  }
}

/**
 * Find the key that authenticates `host`, trying candidates in order.
 * Returns `ok: false` when every key was rejected or the host is unreachable.
 */
export async function probeSite(opts: ProbeOptions, keys?: string[]): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const candidates = keys ?? (await availableKeys(opts.home));

  for (const keyName of candidates) {
    if (!(await exists(path.join(opts.home, '.ssh', keyName)))) continue;
    if (await tryKey(opts, keyName, timeoutMs)) {
      return { host: opts.host, key: keyName, ok: true, message: `authenticated with ${keyName}` };
    }
  }

  return {
    host: opts.host,
    ok: false,
    message: candidates.length === 0 ? 'no keys available' : 'no available key was accepted',
  };
}
