/**
 * Environment discovery for `gs init`.
 *
 * Reads the current machine and proposes a starter profile:
 *  - the global git identity (~/.gitconfig)
 *  - SSH hosts already defined in ~/.ssh/config, and which key they use
 *  - Git repositories under a root directory, grouped by top-level folder
 *  - the remote host of those repositories, so we know which sites matter
 *
 * Discovery never writes anything; `init` decides what to keep.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { toPosix } from './paths.ts';
import { exists } from '../util/fs-atomic.ts';

const run = promisify(execFile);

export interface DiscoveredIdentity {
  name: string;
  email: string;
}

export interface DiscoveredHost {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  aliases: string[];
}

export interface DiscoveredRepo {
  path: string;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
}

export interface DiscoveredGroup {
  dir: string;
  count: number;
  /** most common remote host among the repositories in this folder */
  remoteHost?: string;
}

export interface Discovery {
  gitUser?: DiscoveredIdentity;
  hosts: DiscoveredHost[];
  repos: DiscoveredRepo[];
  groups: DiscoveredGroup[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

export async function discoverGitIdentity(cwd = process.cwd()): Promise<DiscoveredIdentity | undefined> {
  const read = async (key: string) => {
    try {
      const { stdout } = await run('git', ['config', '--global', '--get', key], { cwd });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  if (!name || !email) return undefined;
  return { name, email };
}

export async function discoverRemoteHost(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return parseRemoteHost(stdout.trim());
  } catch {
    return undefined;
  }
}

/** Parsed form of a remote URL: the pieces a site definition needs. */
export interface RemoteTarget {
  host: string;
  port?: number;
  user?: string;
}

export async function discoverRemoteTarget(repoPath: string): Promise<RemoteTarget | undefined> {
  try {
    const { stdout } = await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return parseRemoteTarget(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Split a remote URL into host/port/user.
 * `ssh://git@host:9092/x` carries a port, which matters for probing: port 22
 * would never answer for a self-hosted server on a custom port.
 */
export function parseRemoteTarget(url: string): RemoteTarget | undefined {
  if (!url) return undefined;

  if (url.includes('://')) {
    try {
      const parsed = new URL(url);
      const target: RemoteTarget = { host: parsed.hostname };
      if (parsed.port) target.port = Number.parseInt(parsed.port, 10);
      if (parsed.username) target.user = decodeURIComponent(parsed.username);
      return target;
    } catch {
      return undefined;
    }
  }

  // scp syntax: [user@]host:path
  const scp = /^(?:([^@/]+)@)?([^:/]+):/.exec(url);
  if (!scp) return undefined;
  const target: RemoteTarget = { host: scp[2] as string };
  if (scp[1]) target.user = scp[1];
  return target;
}

/** `git@host:owner/repo.git` / `ssh://git@host:9092/g/p.git` / `https://host/o/r.git` */
export function parseRemoteHost(url: string): string | undefined {
  if (!url) return undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/.exec(url);
  if (scp && !url.includes('://')) return scp[1];
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export interface ScanRepoOptions {
  root: string;
  /** how deep to look for repositories */
  maxDepth?: number;
  /** stop after this many repositories */
  limit?: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'venv',
  '.idea', '.vscode', '__pycache__', '.gradle', 'out', 'bin', 'obj', 'coverage',
]);

export async function scanRepositories(opts: ScanRepoOptions): Promise<{ repos: DiscoveredRepo[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 3;
  const limit = opts.limit ?? 60;
  const repos: DiscoveredRepo[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (repos.length >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
      const repo: DiscoveredRepo = { path: toPosix(dir) };
      const target = await discoverRemoteTarget(dir);
      if (target) {
        repo.remoteHost = target.host;
        if (target.port !== undefined) repo.remotePort = target.port;
        if (target.user !== undefined) repo.remoteUser = target.user;
      }
      repos.push(repo);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  };

  await walk(opts.root, 0);
  return { repos, truncated };
}

export function groupRepositories(repos: DiscoveredRepo[], root: string): DiscoveredGroup[] {
  const groups = new Map<string, { count: number; hosts: Map<string, number> }>();
  const rootPosix = toPosix(root).replace(/\/+$/, '');

  for (const repo of repos) {
    const repoPosix = toPosix(repo.path).replace(/\/+$/, '');
    if (repoPosix === rootPosix) continue; // the scan root itself is a repository
    const rel = toPosix(path.relative(root, repo.path));
    if (!rel || rel.startsWith('..')) continue;

    // A repository sitting directly under the scan root (`code/myrepo`) is its
    // own group; deeper ones group by the first path segment (`code/github/x`).
    const segments = rel.split('/').filter(Boolean);
    const dir = segments.length <= 1
      ? repoPosix
      : toPosix(path.join(root, segments[0] as string));

    const bucket = groups.get(dir) ?? { count: 0, hosts: new Map<string, number>() };
    bucket.count += 1;
    if (repo.remoteHost) bucket.hosts.set(repo.remoteHost, (bucket.hosts.get(repo.remoteHost) ?? 0) + 1);
    groups.set(dir, bucket);
  }
  return [...groups.entries()]
    .map(([dir, { count, hosts }]) => {
      const top = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0];
      const group: DiscoveredGroup = { dir, count };
      if (top) group.remoteHost = top[0];
      return group;
    })
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* ssh                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse the User-level SSH config for Host blocks that pin an IdentityFile.
 * Only literal, non-wildcard host blocks are reported; `Match` blocks are
 * ignored because we cannot evaluate their conditions reliably.
 *
 * `host` is the effective target (HostName when present); `aliases` holds every
 * Host pattern, so `ssh.github.com` and `github.com` can be recognised as the
 * same site.
 */
export function parseSshConfig(text: string): DiscoveredHost[] {
  const hosts: DiscoveredHost[] = [];
  let current: DiscoveredHost | undefined;

  const flush = () => {
    if (current && current.identityFile && !current.aliases.some((a) => /[*?!]/.test(a))) {
      hosts.push(current);
    }
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;
    const match = /^(\w+)[\s=]+(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] as string).toLowerCase();
    const value = (match[2] as string).trim().replace(/^"(.*)"$/, '$1').trim();

    if (key === 'host') {
      flush();
      const aliases = value.split(/\s+/).filter(Boolean);
      const primary = aliases[0];
      if (!primary) continue;
      current = { host: primary, aliases };
      continue;
    }
    if (key === 'match') {
      flush();
      continue;
    }
    if (!current) continue;

    if (key === 'hostname') current.host = value;
    else if (key === 'user') current.user = value;
    else if (key === 'port') {
      const port = Number.parseInt(value, 10);
      if (Number.isInteger(port)) current.port = port;
    } else if (key === 'identityfile') current.identityFile = value;
  }
  flush();
  return hosts;
}

function stripComment(line: string): string {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

export function sshKeyName(identityFile: string): string | undefined {
  const normalised = identityFile.replace(/\\/g, '/');
  const base = normalised.split('/').pop();
  if (!base) return undefined;
  return base.replace(/\.pub$/, '');
}

/**
 * Collapse well-known alternate endpoints onto their canonical host, so that
 * `ssh.github.com` (port 443 workaround) is treated as `github.com`.
 */
export function canonicalHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === 'ssh.github.com') return 'github.com';
  if (lower === 'ssh.gitlab.com') return 'gitlab.com';
  return lower;
}

/**
 * Key files ssh tries when a host has no `IdentityFile`: the well-known default
 * names, in ssh's preference order. Used to attribute a working site to the key
 * that actually authenticates it.
 */
export const DEFAULT_KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa'];

/* ------------------------------------------------------------------ */
/* orchestration                                                       */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
  home: string;
  root?: string;
  scanRoots?: string[];
  cwd?: string;
}

export async function discover(opts: DiscoverOptions): Promise<Discovery> {
  const warnings: string[] = [];
  const gitUser = await discoverGitIdentity(opts.cwd);

  const sshConfigPath = path.join(opts.home, '.ssh', 'config');
  let hosts: DiscoveredHost[] = [];
  if (await exists(sshConfigPath)) {
    const text = await readFile(sshConfigPath, 'utf8').catch(() => '');
    hosts = parseSshConfig(text);
  } else {
    // contract the home prefix and use forward slashes, matching how every other
    // path is shown; an absolute machine path is noise in a report
    const shown = sshConfigPath.startsWith(opts.home)
      ? `~${toPosix(sshConfigPath.slice(opts.home.length))}`
      : toPosix(sshConfigPath);
    warnings.push(`no ${shown}; SSH hosts could not be detected`);
  }

  const roots = opts.scanRoots ?? (opts.root ? [opts.root] : []);
  const repos: DiscoveredRepo[] = [];
  for (const root of roots) {
    const info = await stat(root).catch(() => undefined);
    if (!info?.isDirectory()) {
      warnings.push(`scan root is not a directory: ${root}`);
      continue;
    }
    const result = await scanRepositories({ root });
    repos.push(...result.repos);
    if (result.truncated) warnings.push(`repository scan under ${root} stopped at the limit`);
  }

  const groups = roots.length === 1 && roots[0]
    ? groupRepositories(repos, roots[0])
    : roots.flatMap((r) => groupRepositories(repos.filter((x) => x.path.startsWith(toPosix(r) + '/')), r));

  return { ...(gitUser ? { gitUser } : {}), hosts, repos, groups, warnings };
}
