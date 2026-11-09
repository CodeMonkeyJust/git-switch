/**
 * Render the managed block for ~/.gitconfig.
 *
 * For every directory rule we emit an `includeIf "gitdir:..."` entry pointing at
 * a per-identity config file. Repository-level overrides are emitted first so
 * they take precedence (git applies later matches for the same file target).
 *
 * Verified against git for Windows: the gitdir value must be absolute, use
 * forward slashes and end with a trailing slash.
 */

import type { Profiles } from '../model.ts';
import { gitdirPattern } from '../paths.ts';

/** Ports configured for a host, so `ssh://git@host:PORT/` can be rewritten. */
function portsForHost(profiles: Profiles, host: string): number[] {
  const ports = new Set<number>();
  for (const site of profiles.sites) {
    if (site.port === undefined || site.port === 22) continue;
    if (site.host === host || (site.alsoRoutes ?? []).includes(host)) ports.add(site.port);
  }
  return [...ports].sort((a, b) => a - b);
}

export interface RenderGitConfigOptions {
  /** how a rule dir maps to an identity config file path */
  identityConfigPath: (identity: string) => string;
  /** represent the home directory as `~` for portability */
  contract: (absolutePath: string) => string;
}

export function renderIncludeIfBlock(profiles: Profiles, opts: RenderGitConfigOptions): string {
  const lines: string[] = [];
  const emitted = new Map<string, string>();

  const push = (dir: string, identity: string, label: string): void => {
    const pattern = gitdirPattern(dir);
    const previous = emitted.get(pattern);
    if (previous !== undefined) {
      if (previous !== identity) {
        throw new Error(`conflicting includeIf targets for ${dir}: ${previous} vs ${identity}`);
      }
      return;
    }
    emitted.set(pattern, identity);
    lines.push(`[includeIf "gitdir:${pattern}"]`);
    lines.push(`\tpath = ${opts.contract(opts.identityConfigPath(identity))}`);
    lines.push(`# ${label}`);
  };

  for (const repo of profiles.repositories) {
    push(repo.path, repo.identity, `gs: repository override ${repo.path}`);
  }
  for (const rule of profiles.rules) {
    push(rule.dir, rule.identity, rule.comment ? `gs: ${rule.comment}` : `gs: rule ${rule.dir}`);
  }

  return lines.join('\n');
}

export function renderIdentityConfig(
  profiles: Profiles,
  identityName: string,
  opts: { aliasFor: (identity: string) => { alias: string; hosts: string[] }[] },
): string {
  const identity = profiles.identities.find((i) => i.name === identityName);
  if (!identity) throw new Error(`unknown identity: ${identityName}`);
  const lines: string[] = [];

  lines.push(`[user]`);
  lines.push(`\tname = ${identity.user.name}`);
  lines.push(`\temail = ${identity.user.email}`);

  if (identity.credentialUsername) {
    lines.push(`[credential]`);
    lines.push(`\tusername = ${identity.credentialUsername}`);
  }

  for (const { alias, hosts } of opts.aliasFor(identity.name)) {
    lines.push(`[url "git@${alias}:"]`);
    for (const host of hosts) {
      // Longer, more specific prefixes must come first: git applies the longest
      // match, and `ssh://git@host:` would otherwise swallow `:9092/path` into
      // the path, producing a broken `git@alias:9092/path`.
      for (const port of portsForHost(profiles, host)) {
        lines.push(`\tinsteadOf = ssh://git@${host}:${port}/`);
      }
      lines.push(`\tinsteadOf = git@${host}:`);
      lines.push(`\tinsteadOf = https://${host}/`);
      lines.push(`\tinsteadOf = ssh://git@${host}/`);
    }
  }

  return lines.join('\n');
}
