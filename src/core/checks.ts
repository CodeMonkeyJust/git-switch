/**
 * Environment checks behind `gs doctor`.
 *
 * Every check returns data; rendering is the caller's job. Checks never throw
 * on a normal problem condition — they report it, so one broken key does not
 * hide the rest of the diagnosis.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Profiles } from './model.ts';
import { keyForSite } from './model.ts';
import { gsPaths, contractHome } from './paths.ts';
import { exists, readFileIfExists } from '../util/fs-atomic.ts';

const run = promisify(execFile);

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
  /** concrete command or action that fixes the problem */
  fix?: string;
}

export interface DoctorOptions {
  home: string;
  profiles: Profiles;
  /** run network-free only; default true (no ssh handshake) */
  offline?: boolean;
  /** probe real connectivity with `ssh -T`; explicit opt-in */
  online?: boolean;
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* individual checks                                                   */
/* ------------------------------------------------------------------ */

/** A declared SSH key must exist and look like a private key. */
export async function checkKeys(home: string, profiles: Profiles): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sshDir = path.join(home, '.ssh');
  const referenced = new Map<string, string[]>();

  for (const identity of profiles.identities) {
    if (!identity.sshKey) {
      results.push({
        id: `key:${identity.name}`,
        level: 'warn',
        title: `${identity.name}: no SSH key configured`,
        detail: 'SSH sites of this identity will fail to authenticate unless another mechanism applies',
        fix: `git-switch: add \`sshKey: id_ed25519_xxx\` to identity ${identity.name}`,
      });
      continue;
    }
    const users = referenced.get(identity.sshKey) ?? [];
    users.push(identity.name);
    referenced.set(identity.sshKey, users);
  }

  for (const [keyName, users] of referenced) {
    const file = path.join(sshDir, keyName);
    const label = `~/.ssh/${keyName}`;
    if (!(await exists(file))) {
      results.push({
        id: `key:${keyName}`,
        level: 'error',
        title: `${label} does not exist`,
        detail: `referenced by ${users.join(', ')}; git push/pull will fail with "no such identity"`,
        fix: `ssh-keygen -t ed25519 -C "<email>" -f "${file}"`,
      });
      continue;
    }

    const info = await stat(file);
    const content = await readFileIfExists(file);
    const looksPrivate = content !== undefined && content.includes('PRIVATE KEY');
    const pubExists = await exists(`${file}.pub`);

    if (!looksPrivate) {
      results.push({
        id: `key:${keyName}`,
        level: 'warn',
        title: `${label} does not look like a private key`,
        detail: 'the file exists but has no private key header',
      });
      continue;
    }

    results.push({
      id: `key:${keyName}`,
      level: 'ok',
      title: `${label} present`,
      detail: `${info.size} bytes${pubExists ? '' : ' · no .pub file'}`,
    });

    const permission = await checkPrivateKeyPermissions(file, info.mode);
    if (permission) results.push(permission);
  }

  return results;
}

/**
 * OpenSSH refuses keys readable by others. On Windows the POSIX mode bits are
 * not authoritative, so we only report what we can prove.
 */
async function checkPrivateKeyPermissions(file: string, mode: number): Promise<CheckResult | undefined> {
  if (process.platform === 'win32') return undefined;
  const perms = mode & 0o777;
  if (perms === 0o600 || perms === 0o400) {
    return { id: `perm:${file}`, level: 'ok', title: `${path.basename(file)} permissions ${perms.toString(8)}` };
  }
  return {
    id: `perm:${file}`,
    level: 'warn',
    title: `${path.basename(file)} permissions are too open (${perms.toString(8)})`,
    detail: 'sshd may refuse the key; OpenSSH expects 600',
    fix: `chmod 600 "${file}"`,
  };
}

/** The generated ssh block must reference keys that exist. */
export async function checkSshConfig(home: string, profiles: Profiles): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sshConfig = path.join(home, '.ssh', 'config');

  if (!(await exists(sshConfig))) {
    if (profiles.sites.length > 0) {
      results.push({
        id: 'ssh:config',
        level: 'warn',
        title: 'no ~/.ssh/config yet',
        detail: 'run `gs apply` to generate the managed host block',
        fix: 'gs apply',
      });
    }
    return results;
  }

  const text = (await readFileIfExists(sshConfig)) ?? '';
  if (!text.includes('# >>> gs:managed >>>')) {
    if (profiles.sites.length > 0) {
      results.push({
        id: 'ssh:block',
        level: 'warn',
        title: '~/.ssh/config has no gs managed block',
        detail: 'generated host aliases are not in place',
        fix: 'gs apply',
      });
    }
    return results;
  }

  // A user block shadows ours only when it defines the *same alias* we generate.
  // Their `Host github.com` and our `Host github` do not collide: they target the
  // same host with the same key, which is the normal migrated setup.
  const outside = text.replace(/# >>> gs:managed >>>[\s\S]*?# <<< gs:managed <<</, '');
  const outsideHosts = new Set<string>();
  for (const line of outside.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (!m || !m[1]) continue;
    for (const name of m[1].trim().split(/\s+/)) outsideHosts.add(name.toLowerCase());
  }

  const shadowing: string[] = [];
  for (const site of profiles.sites) {
    const alias = site.alias;
    if (!alias) continue;
    // exact token match only: `github` must not match `github.com`
    if (outsideHosts.has(alias.toLowerCase())) shadowing.push(alias);
  }
  if (shadowing.length > 0) {
    results.push({
      id: 'ssh:shadow',
      level: 'warn',
      title: `host aliases also defined outside the gs block: ${shadowing.join(', ')}`,
      detail: 'OpenSSH uses the first match, so your own entries take precedence',
    });
  } else {
    results.push({ id: 'ssh:block', level: 'ok', title: '~/.ssh/config managed block present' });
  }

  // A wildcard block that pins IdentityFile is applied BEFORE our host-specific
  // blocks, so ssh offers the wrong key first. `IdentitiesOnly yes` narrows the
  // set but cannot reorder it, which is exactly how "Permission denied
  // (publickey)" happens on an otherwise correct setup.
  const wildcardKeys = wildcardIdentityFiles(outside);
  if (wildcardKeys.length > 0) {
    results.push({
      id: 'ssh:wildcard-key',
      level: 'warn',
      title: `a wildcard Host block pins IdentityFile (${wildcardKeys.join(', ')})`,
      detail:
        'OpenSSH applies wildcard IdentityFile entries before host-specific ones, so the wrong key ' +
        'may be offered first and authentication can fail',
      fix: 'remove IdentityFile from the wildcard block, or set it explicitly per Host',
    });
  }

  return results;
}

/**
 * IdentityFile entries declared inside a wildcard `Host *` (or similar) block.
 * Those apply to every connection and are ordered before specific blocks.
 */
function wildcardIdentityFiles(configText: string): string[] {
  const keys: string[] = [];
  let inWildcard = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const hostMatch = /^host\s+(.+)$/i.exec(line);
    if (hostMatch) {
      inWildcard = (hostMatch[1] ?? '').trim().split(/\s+/).includes('*');
      continue;
    }
    if (inWildcard) {
      const keyMatch = /^identityfile\s+(.+)$/i.exec(line);
      if (keyMatch) keys.push((keyMatch[1] ?? '').trim());
    }
  }
  return keys;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every git host in the profile should be reachable in principle. */
export async function checkGitIdentityForDirectory(
  home: string,
  profiles: Profiles,
  dir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const hasRepo = await exists(path.join(dir, '.git'));

  if (!hasRepo) {
    results.push({
      id: 'dir:repo',
      level: 'warn',
      title: `${contractHome(dir, home)} is not a Git repository`,
      detail: 'includeIf "gitdir:" only applies inside repositories',
    });
    return results;
  }

  try {
    const { stdout } = await run('git', ['-C', dir, 'config', '--show-origin', '--get', 'user.email'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const [origin = '', ...rest] = stdout.trim().split(/\s+/);
    const email = rest.join(' ');

    // A repository-local user.email silently beats every includeIf rule. Repos
    // created before adopting gs usually carry one, so surface it explicitly.
    if (/\.git[\/\\]config$/i.test(origin)) {
      results.push({
        id: 'dir:repo-local-identity',
        level: 'warn',
        title: `this repository overrides its identity locally (${email})`,
        detail: 'repository-local user.email takes precedence over every directory rule',
        fix: 'git config --local --unset user.email (and user.name) to inherit from the directory rule',
      });
      return results;
    }

    if (origin.includes('gs/identities') || origin.includes('gs\\identities')) {
      results.push({ id: 'dir:identity', level: 'ok', title: `identity here: ${email}` });
    } else {
      results.push({
        id: 'dir:identity',
        level: 'warn',
        title: `identity here comes from ${contractHome(origin, home)}`,
        detail: `resolved email is ${email}; no gs rule matched this repository`,
        fix: 'add a rule in profiles.yaml, then gs apply',
      });
    }
  } catch {
    results.push({
      id: 'dir:identity',
      level: 'warn',
      title: 'could not resolve a git identity for this repository',
      detail: 'user.email is not set for this path',
    });
  }
  return results;
}

/** Real `ssh -T` handshakes; only run when the user asks for it. */
export async function checkConnectivity(
  home: string,
  profiles: Profiles,
  timeoutMs = 10_000,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const site of profiles.sites) {
    const key = keyForSite(profiles, site);
    if (!key || !(await exists(path.join(home, '.ssh', key)))) {
      results.push({
        id: `ssh:${site.host}`,
        level: 'warn',
        title: `${site.host}: skipped connectivity probe`,
        detail: 'no usable SSH key for this site',
      });
      continue;
    }
    const target = site.alias ?? site.host;
    try {
      const { stderr } = await run(
        'ssh',
        ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
         '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`, '-p', String(site.port ?? 22), target],
        { timeout: timeoutMs, env: { ...process.env, HOME: home, USERPROFILE: home } },
      );
      results.push({
        id: `ssh:${site.host}`,
        level: 'ok',
        title: `${site.host}: authenticated`,
        detail: firstLine(stderr),
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
      const message = firstLine(stderr);
      results.push({
        id: `ssh:${site.host}`,
        level: 'error',
        title: `${site.host}: authentication failed`,
        detail: message,
        fix: `ssh -T -p ${site.port ?? 22} ${target}`,
      });
    }
  }
  return results;
}

function firstLine(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
}

/* ------------------------------------------------------------------ */
/* orchestration                                                       */
/* ------------------------------------------------------------------ */

export async function runDoctor(opts: DoctorOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { home, profiles } = opts;

  results.push({ id: 'profile', level: 'ok', title: `profile loaded`, detail: contractHome(gsPaths(home).profiles, home) });
  results.push(...(await checkKeys(home, profiles)));
  results.push(...(await checkSshConfig(home, profiles)));
  results.push(...(await checkGitIdentityForDirectory(home, profiles, process.cwd())));

  if (opts.online) {
    results.push(...(await checkConnectivity(home, profiles, opts.timeoutMs ?? 10_000)));
  } else {
    results.push({
      id: 'connectivity',
      level: 'warn',
      title: 'connectivity not probed',
      detail: 'pass --online to run real ssh handshakes',
    });
  }

  return results;
}

export { access, constants };
