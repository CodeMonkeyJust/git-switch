import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { discover, canonicalHost, sshKeyName, type Discovery } from '../core/discover.ts';
import { probeSite, availableKeys } from '../core/probe.ts';
import { DEFAULT_SETTINGS, type Profiles, type Site } from '../core/model.ts';
import { saveProfiles, profilesExist } from '../core/profiles.ts';
import { gsPaths, contractHome, normaliseRulePath, toPosix } from '../core/paths.ts';
import { exists, writeFileAtomic } from '../util/fs-atomic.ts';
import type { Logger } from '../util/log.ts';
import { stringify } from '../core/yaml.ts';
import { toYaml } from '../core/model.ts';

export interface InitOptions {
  home?: string;
  cwd?: string;
  /** directories to scan for repositories */
  roots?: string[];
  /** write a profile even when one already exists */
  force?: boolean;
  /** skip network probing of keyless sites */
  offline?: boolean;
  json?: boolean;
  logger: Logger;
}

/** Top-level folders that commonly hold one identity per account. */
const GROUP_HINTS = ['gitee', 'github', 'gitlab', 'bitbucket', 'company', 'work'];

/** Hosts that are almost always personal accounts, not the work email. */
const PUBLIC_FORGES = ['github.com', 'gitee.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];

export async function initCommand(opts: InitOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const { logger } = opts;
  const paths = gsPaths(home);

  if ((await profilesExist(home)) && !opts.force) {
    logger.error(`a profile already exists at ${contractHome(paths.profiles, home)}`);
    logger.dim('use --force to overwrite it (a backup is not taken automatically)');
    return 2;
  }

  // Default to the parent of the working directory: users usually run `gs init`
  // inside a project, but the interesting grouping is one level up.
  const roots = opts.roots ?? [path.resolve(cwd, '..')];
  const found: Discovery = await discover({ home, root: roots[0] as string, scanRoots: roots, cwd });

  const profiles = buildProfiles(found, { home, roots, groups: GROUP_HINTS });

  if (logger.isJson) {
    logger.json({
      profile: contractHome(paths.profiles, home),
      identities: profiles.identities.map((i) => ({ name: i.name, email: i.user.email })),
      sites: profiles.sites.map((s) => ({ host: s.host, identity: s.identity })),
      rules: profiles.rules.map((r) => ({ dir: contractHome(r.dir, home), identity: r.identity })),
      warnings: found.warnings,
    });
    if (!(await profilesExist(home)) || opts.force) {
      await saveProfiles(home, profiles);
    }
    return 0;
  }

  logger.info('detected');
  logger.dim(`  git identity   ${found.gitUser ? `${found.gitUser.name} <${found.gitUser.email}>` : 'none (global user.name/email not set)'}`);
  logger.dim(`  ssh hosts      ${found.hosts.length}`);
  logger.dim(`  repositories   ${found.repos.length}`);

  // discovery warnings belong to the "detected" section, not above it
  for (const warning of found.warnings) logger.warn(warning);

  if (profiles.identities.length === 0) {
    logger.error('could not determine any identity: set user.name and user.email in git first');
    return 2;
  }

  logger.info('proposed identities');
  for (const identity of profiles.identities) {
    const keys = profiles.sites.filter((s) => s.identity === identity.name).map((s) => s.host);
    logger.dim(`  ${identity.name.padEnd(12)} ${identity.user.name} <${identity.user.email}>${keys.length ? `  → ${keys.join(', ')}` : ''}`);
  }

  if (profiles.rules.length > 0) {
    logger.info('proposed rules');
    for (const rule of profiles.rules) {
      logger.dim(`  ${contractHome(rule.dir, home)}  →  ${rule.identity}`);
    }
  } else {
    logger.warn('no directory rules could be inferred; add them to profiles.yaml');
  }

  // A site with no IdentityFile in ~/.ssh/config may still work: ssh falls back
  // to its default key names. Probe those before claiming the site is keyless,
  // otherwise init would report a problem that does not exist.
  if (!opts.offline) {
    const probed = await probeMissingKeys(profiles, { home, logger });
    if (probed > 0) {
      logger.info('ssH keys discovered by probing');
      for (const identity of profiles.identities) {
        if (identity.sshKey) logger.dim(`   ${identity.name}  ->  ${identity.sshKey}`);
      }
    }
  }

  for (const site of profiles.sites) {
    if (!siteKey(profiles, site)) {
      logger.warn(
        `${site.host}: no SSH key works yet; add sshKey to the identity in profiles.yaml ` +
          `(gs doctor --online shows the details)`,
      );
    }
  }

  // Every generated identity inherits the global git identity, because that is
  // the only email gs can know. Public forges commonly want a personal address,
  // so name the identities most likely to need one instead of a blanket hint.
  const emails = new Set(profiles.identities.map((i) => i.user.email));
  if (emails.size === 1 && profiles.identities.length > 1) {
    const only = [...emails][0] as string;
    const likelyPersonal = profiles.identities.filter((i) =>
      (PUBLIC_FORGES as readonly string[]).some((f) =>
        profiles.sites.some((s) => s.identity === i.name && s.host.toLowerCase().includes(f)),
      ),
    );

    logger.warn(`all ${profiles.identities.length} identities were given the global email ${only}`);
    if (likelyPersonal.length > 0) {
      logger.dim(`   likely personal: ${likelyPersonal.map((i) => i.name).join(', ')}`);
      logger.dim('   edit ~/.config/gs/profiles.yaml and set user.email per identity, then re-run gs apply');
    } else {
      logger.dim('   edit ~/.config/gs/profiles.yaml and set user.email per identity');
    }
  }

  await saveProfiles(home, profiles);
  logger.ok(`wrote ${contractHome(paths.profiles, home)}`);
  logger.dim('next: review identities/emails above, then: gs diff   then   gs apply');
  return 0;
}

function siteKey(profiles: Profiles, site: Site): string | undefined {
  return site.sshKey ?? profiles.identities.find((i) => i.name === site.identity)?.sshKey;
}

/**
 * Attach a working key to identities that have none, by probing their sites.
 * Only identities whose sites are all keyless participate; a site that already
 * declares a key is trusted as-is.
 */
async function probeMissingKeys(
  profiles: Profiles,
  ctx: { home: string; logger: Logger },
): Promise<number> {
  const keyless = profiles.identities.filter((identity) => !identity.sshKey);
  if (keyless.length === 0) return 0;

  const keys = await availableKeys(ctx.home);
  if (keys.length === 0) return 0;

  let discovered = 0;
  for (const identity of keyless) {
    const sites = profiles.sites.filter((s) => s.identity === identity.name);
    for (const site of sites) {
      const result = await probeSite(
        { home: ctx.home, host: site.host, ...(site.port !== undefined ? { port: site.port } : {}), ...(site.user !== undefined ? { user: site.user } : {}) },
        keys,
      );
      if (result.ok && result.key) {
        identity.sshKey = result.key;
        discovered += 1;
        break; // one good key per identity is enough
      }
    }
  }
  return discovered;
}

export interface BuildOptions {
  home: string;
  roots: string[];
  groups: string[];
}

const BUILD_HINTS = ['gitee', 'github', 'gitlab', 'bitbucket', 'company', 'work'];

/**
 * Map discovery output onto a concrete profiles object.
 *
 * Heuristics, in priority order:
 *  1. One identity named after the detected site for each SSH host with a key.
 *  2. Top-level folder name matches a known group (gitee/github/work...) → that site.
 *  3. Otherwise a single `default` identity using the global git identity.
 */
export function buildProfiles(found: Discovery, opts: BuildOptions): Profiles {
  const identities: Profiles['identities'] = [];
  const sites: Site[] = [];
  const usedNames = new Set<string>();

  const uniqueName = (base: string): string => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}${n++}`;
    usedNames.add(name);
    return name;
  };

  // One identity per canonical site. Alternate endpoints (ssh.github.com on
  // port 443) collapse onto the same identity instead of producing duplicates.
  //
  // Aliases must not reuse any Host name the user already defines, otherwise the
  // generated block would emit a duplicate `Host` entry that OpenSSH ignores
  // (first match wins) and `gs doctor` would rightly complain about.
  const occupiedHostNames = new Set<string>();
  for (const host of found.hosts) {
    for (const name of host.aliases) occupiedHostNames.add(name.toLowerCase());
    occupiedHostNames.add(host.host.toLowerCase());
  }

  const hostToIdentity = new Map<string, string>();
  const canonicalToIdentity = new Map<string, string>();
  for (const host of found.hosts) {
    const keyFile = host.identityFile;
    if (!keyFile) continue;
    const key = sshKeyName(keyFile);
    if (!key) continue;

    const canonical = canonicalHost(host.host);
    const existing = canonicalToIdentity.get(canonical);
    if (existing) {
      // already have this site: just record the extra endpoint for lookups
      hostToIdentity.set(canonical, existing);
      for (const a of host.aliases) hostToIdentity.set(a.toLowerCase(), existing);
      continue;
    }

    const identityName = uniqueName(identityNameFor(canonical));
    canonicalToIdentity.set(canonical, identityName);
    identities.push({
      name: identityName,
      user: {
        name: found.gitUser?.name ?? 'unknown',
        email: found.gitUser?.email ?? `${identityName}@example.com`,
      },
      sshKey: key,
    });
    // `host` is the real Git host users write in remotes; the SSH endpoint
    // (ssh.github.com) goes into sshHostName so routing stays correct.
    const site: Site = { host: canonical, identity: identityName };
    if (canonicalHost(host.host) !== host.host.toLowerCase()) site.sshHostName = host.host;
    if (host.port !== undefined) site.port = host.port;
    if (host.user !== undefined) site.user = host.user;
    const alias = pickAlias(canonical, host.aliases, occupiedHostNames);
    if (alias) site.alias = alias;
    sites.push(site);
    hostToIdentity.set(canonical, identityName);
    hostToIdentity.set(host.host.toLowerCase(), identityName);
    for (const aliasName of host.aliases) hostToIdentity.set(aliasName.toLowerCase(), identityName);
  }

  // fall back to a single default identity
  if (identities.length === 0) {
    const base = found.gitUser ?? { name: 'default', email: 'default@example.com' };
    const name = uniqueName('default');
    identities.push({ name, user: { name: base.name, email: base.email } });
  }

  const defaultIdentity = (identities[0] as Profiles['identities'][number]).name;

  // Sites seen in repository remotes but not covered by ~/.ssh/config still need
  // an identity, otherwise their repositories silently fall back to the global
  // identity — the exact problem gs exists to prevent.
  const coveredHosts = new Set(sites.map((s) => s.host.toLowerCase()));
  const remoteHostToIdentity = new Map<string, string>();
  const seenRemote = new Set<string>();
  for (const repo of found.repos) {
    if (!repo.remoteHost) continue;
    const key = repo.remoteHost.toLowerCase();
    const canonical = canonicalHost(key);
    if (hostToIdentity.has(key) || hostToIdentity.has(canonical)) continue;
    if (seenRemote.has(canonical)) continue;
    seenRemote.add(canonical);
    const identityName = uniqueName(identityNameFor(canonical));
    identities.push({
      name: identityName,
      user: {
        name: found.gitUser?.name ?? 'unknown',
        email: found.gitUser?.email ?? `${identityName}@example.com`,
      },
    });
    sites.push({
      host: repo.remoteHost,
      identity: identityName,
      // keep the port the repository actually uses: without it a probe would
      // dial the default 22 and wrongly conclude the site has no working key
      ...(repo.remotePort !== undefined ? { port: repo.remotePort } : {}),
      ...(repo.remoteUser !== undefined ? { user: repo.remoteUser } : {}),
    });
    remoteHostToIdentity.set(key, identityName);
  }

  const lookup = (host: string | undefined): string | undefined => {
    if (!host) return undefined;
    const key = host.toLowerCase();
    return hostToIdentity.get(key) ?? remoteHostToIdentity.get(canonicalHost(key));
  };

  const rules: Profiles['rules'] = [];
  for (const group of found.groups) {
    const mapped = lookup(group.remoteHost);
    const hinted = opts.groups.find(
      (g) => `/${group.dir.toLowerCase()}/`.includes(`/${g.toLowerCase()}/`),
    );
    let identity = mapped;
    if (!identity && hinted) {
      identity = identities.find((i) => {
        const host = siteFor(sites, i.name)?.toLowerCase() ?? '';
        return host.includes(hinted.toLowerCase()) || i.name.includes(hinted.toLowerCase());
      })?.name;
    }
    // a single identity is unambiguous: map every group to it
    if (!identity && identities.length === 1) identity = defaultIdentity;
    if (!identity) continue;
    rules.push({ dir: toPosix(group.dir), identity });
  }

  const seen = new Set<string>();
  const uniqueRules = rules.filter((r) => {
    const lower = r.dir.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  return {
    schemaVersion: 1,
    identities,
    sites,
    rules: uniqueRules,
    repositories: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function siteFor(sites: Site[], identity: string): string | undefined {
  return sites.find((s) => s.identity === identity)?.host;
}

function identityNameFor(host: string): string {
  // IP addresses and generic hosts do not name anything useful
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'internal';
  const base = host
    .toLowerCase()
    .replace(/^ssh\./, '')
    .replace(/^www\./, '');
  // `git.pdesoft.cn` -> `pde`; `github.com` -> `github`
  const parts = base.split('.').filter(Boolean);
  const first = parts[0] ?? 'host';
  const cleaned = (first === 'git' && parts.length > 1 ? (parts[1] as string) : first)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'host';
}

/**
 * An SSH alias must be a usable hostname-like token that does not collide with a
 * real host. Numeric strings and the generic `ssh` are rejected.
 */
function aliasFor(host: string): string | undefined {
  const name = identityNameFor(host);
  if (!name || name === 'internal' || name === 'host') return undefined;
  if (/^\d+$/.test(name)) return undefined;
  if (name === 'ssh' || name === 'git' || name === 'www') return undefined;
  return name;
}

/**
 * Choose an alias that is free. When the natural name is already used by the
 * user's own config we suffix it with `-gs` rather than colliding.
 */
function pickAlias(canonical: string, existingAliases: string[], occupied: Set<string>): string | undefined {
  const base = aliasFor(canonical);
  if (!base) return undefined;
  if (!occupied.has(base.toLowerCase())) return base;
  const suffixed = `${base}-gs`;
  if (!occupied.has(suffixed.toLowerCase())) return suffixed;
  // extremely unlikely: fall back to a stable numbered variant
  let n = 2;
  while (occupied.has(`${base}-gs${n}`.toLowerCase())) n++;
  return `${base}-gs${n}`;
}

/** Used by tests and by `init --json`: the serialised profile text. */
export function renderProfileText(profiles: Profiles): string {
  return stringify(toYaml(profiles));
}

export async function listSshKeys(home: string): Promise<string[]> {
  const dir = path.join(home, '.ssh');
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir).catch(() => []);
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pub')) continue;
    const name = entry.replace(/\.pub$/, '');
    const priv = await readFile(path.join(dir, name), 'utf8').catch(() => undefined);
    if (priv === undefined) continue;
    keys.push(name);
  }
  return keys.sort();
}

export { normaliseRulePath, writeFileAtomic };
