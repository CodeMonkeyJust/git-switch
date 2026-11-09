import { normaliseRulePath, toPosix } from './paths.ts';
import type { YamlValue } from './yaml.ts';

/**
 * Data model for `profiles.yaml` — the single source of truth.
 *
 * Hard invariant: this file may NEVER contain secrets. Validation rejects any
 * key that looks like a password, token or private key. SSH keys are referenced
 * by name only and resolved under ~/.ssh.
 */

export const SCHEMA_VERSION = 1;

export class ModelError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'ModelError';
    this.path = path;
  }
}

export interface GitUser {
  name: string;
  email: string;
}

export interface SshSiteOptions {
  /** Original host to keep working, e.g. github.com mapped to ssh.github.com:443. */
  hostName?: string;
  port?: number;
  user?: string;
}

export interface Site {
  host: string;
  port?: number;
  user?: string;
  /** Applies to plain https/ssh remotes of this host. */
  identity: string;
  /** ssh key file name under ~/.ssh, defaults to the identity's key. */
  sshKey?: string;
  /** extra Host alias that maps onto the same target (e.g. gh-alias). */
  alias?: string;
  /**
   * HostName Override for the generated SSH block. Used when a site is reached
   * through an alternate endpoint (github.com via ssh.github.com).
   */
  sshHostName?: string;
  /**
   * Additional Git hostnames that should route through this site's alias.
   * Only for real git hosts, never SSH endpoints.
   */
  alsoRoutes?: string[];
}

export interface Identity {
  name: string;
  user: GitUser;
  /** ssh key file name under ~/.ssh */
  sshKey?: string;
  /** HTTPS credential username, when it differs from user.name */
  credentialUsername?: string;
}

export interface Rule {
  /** absolute, forward-slash path */
  dir: string;
  identity: string;
  /** display only */
  comment?: string;
}

export interface RepoOverride {
  path: string;
  identity: string;
}

export interface Settings {
  backupKeep: number;
  /** roots that the GUI file browser may walk in addition to ~ and rule dirs */
  allowRoots: string[];
}

export interface Profiles {
  schemaVersion: number;
  identities: Identity[];
  sites: Site[];
  rules: Rule[];
  repositories: RepoOverride[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  backupKeep: 20,
  allowRoots: [],
};

/* ------------------------------------------------------------------ */
/* Secret guard                                                        */
/* ------------------------------------------------------------------ */

const FORBIDDEN_KEY = /^(password|passphrase|token|secret|apikey|api_key|privatekey|private_key|credential|credentials)$/i;
const FORBIDDEN_VALUE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export function assertNoSecrets(value: YamlValue, path = '$'): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) {
      throw new ModelError('private key material must never be stored in profiles.yaml', path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) {
        throw new ModelError(
          `key "${k}" is not allowed: profiles.yaml must not contain secrets ` +
            `(use your OS credential manager or ssh-agent)`,
          `${path}.${k}`,
        );
      }
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

type Obj = { [key: string]: YamlValue };

function asObject(value: YamlValue | undefined, path: string): Obj {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelError('expected a mapping', path);
  }
  return value;
}

function asArray(value: YamlValue | undefined, path: string): YamlValue[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ModelError('expected a list', path);
  return value;
}

function asString(value: YamlValue | undefined, path: string, fallback?: string): string {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ModelError('expected a string', path);
  }
  if (typeof value !== 'string') throw new ModelError('expected a string', path);
  return value;
}

function asOptionalString(value: YamlValue | undefined, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asString(value, path);
}

function asOptionalInt(value: YamlValue | undefined, path: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new ModelError('expected an integer', path);
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const KEY_NAME_RE = /^[A-Za-z0-9._-]+$/;
const IDENTITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function parseIdentity(raw: YamlValue, path: string, name: string): Identity {
  const obj = asObject(raw, path);
  if (!IDENTITY_NAME_RE.test(name)) {
    throw new ModelError('identity name may contain only letters, digits, dot, dash and underscore', path);
  }
  const user = asObject(obj.user, `${path}.user`);
  const userName = asString(user.name, `${path}.user.name`);
  const email = asString(user.email, `${path}.user.email`);
  if (!EMAIL_RE.test(email)) throw new ModelError(`not a valid email: ${email}`, `${path}.user.email`);

  const sshKey = asOptionalString(obj.sshKey, `${path}.sshKey`);
  if (sshKey !== undefined && !KEY_NAME_RE.test(sshKey)) {
    throw new ModelError('sshKey must be a file name under ~/.ssh', `${path}.sshKey`);
  }
  const credentialUsername = asOptionalString(obj.credentialUsername, `${path}.credentialUsername`);

  return {
    name,
    user: { name: userName, email },
    ...(sshKey !== undefined ? { sshKey } : {}),
    ...(credentialUsername !== undefined ? { credentialUsername } : {}),
  };
}

function parseSite(raw: YamlValue, path: string, defaultIdentity: string): Site {
  const obj = asObject(raw, path);
  const host = asString(obj.host, `${path}.host`);
  if (!HOST_RE.test(host)) throw new ModelError(`not a valid host: ${host}`, `${path}.host`);

  const port = asOptionalInt(obj.port, `${path}.port`);
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new ModelError('port out of range', `${path}.port`);
  }
  const user = asOptionalString(obj.user, `${path}.user`);
  const identity = asString(obj.identity, `${path}.identity`, defaultIdentity);
  const sshKey = asOptionalString(obj.sshKey, `${path}.sshKey`);
  if (sshKey !== undefined && !KEY_NAME_RE.test(sshKey)) {
    throw new ModelError('sshKey must be a file name under ~/.ssh', `${path}.sshKey`);
  }
  const alias = asOptionalString(obj.alias, `${path}.alias`);
  if (alias !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(alias)) {
    throw new ModelError('alias must be a hostname-like token', `${path}.alias`);
  }
  const sshHostName = asOptionalString(obj.sshHostName, `${path}.sshHostName`);
  if (sshHostName !== undefined && !HOST_RE.test(sshHostName)) {
    throw new ModelError(`not a valid host: ${sshHostName}`, `${path}.sshHostName`);
  }
  const alsoRoutes = asArray(obj.alsoRoutes, `${path}.alsoRoutes`).map((v, i) => {
    const h = asString(v, `${path}.alsoRoutes[${i}]`);
    if (!HOST_RE.test(h)) throw new ModelError(`not a valid host: ${h}`, `${path}.alsoRoutes[${i}]`);
    return h;
  });

  const site: Site = { host, identity };
  if (port !== undefined) site.port = port;
  if (user !== undefined) site.user = user;
  if (sshKey !== undefined) site.sshKey = sshKey;
  if (alias !== undefined) site.alias = alias;
  if (sshHostName !== undefined) site.sshHostName = sshHostName;
  if (alsoRoutes.length > 0) site.alsoRoutes = alsoRoutes;
  return site;
}

export interface ParseOptions {
  home?: string;
  cwd?: string;
}

export function fromYaml(raw: Obj, opts: ParseOptions = {}): Profiles {
  assertNoSecrets(raw);

  const schemaVersion = asOptionalInt(raw.schemaVersion, 'schemaVersion');
  if (schemaVersion === undefined) {
    throw new ModelError('missing schemaVersion', 'schemaVersion');
  }
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ModelError(
      `unsupported schemaVersion ${schemaVersion} (this build supports ${SCHEMA_VERSION})`,
      'schemaVersion',
    );
  }

  const identitiesObj = asObject(raw.identities, 'identities');
  const identities: Identity[] = Object.entries(identitiesObj).map(([name, value]) =>
    parseIdentity(value, `identities.${name}`, name),
  );

  const byName = new Map(identities.map((i) => [i.name, i]));
  if (byName.size === 0) throw new ModelError('at least one identity is required', 'identities');

  // sites may be nested under an identity or declared at the top level
  const sites: Site[] = [];
  for (const identity of identities) {
    const identityRaw = asObject(identitiesObj[identity.name], `identities.${identity.name}`);
    const nested = asArray(identityRaw.sites, `identities.${identity.name}.sites`);
    nested.forEach((s, i) =>
      sites.push(parseSite(s, `identities.${identity.name}.sites[${i}]`, identity.name)),
    );
  }
  asArray(raw.sites, 'sites').forEach((s, i) => sites.push(parseSite(s, `sites[${i}]`, '')));

  for (const [i, site] of sites.entries()) {
    if (!site.identity) throw new ModelError('site requires an identity', `sites[${i}].identity`);
    if (!byName.has(site.identity)) {
      throw new ModelError(`unknown identity "${site.identity}"`, `sites[${i}].identity`);
    }
  }

  const seenHosts = new Set<string>();
  for (const [i, site] of sites.entries()) {
    const key = `${site.host}:${site.port ?? 22}`;
    if (seenHosts.has(key)) throw new ModelError(`duplicate site ${key}`, `sites[${i}]`);
    seenHosts.add(key);
  }

  const rules: Rule[] = asArray(raw.rules, 'rules').map((r, i) => {
    const path = `rules[${i}]`;
    const obj = asObject(r, path);
    const dir = normaliseRulePath(asString(obj.dir, `${path}.dir`), opts.home, opts.cwd);
    const identity = asString(obj.identity, `${path}.identity`);
    if (!byName.has(identity)) {
      throw new ModelError(`unknown identity "${identity}"`, `${path}.identity`);
    }
    const comment = asOptionalString(obj.comment, `${path}.comment`);
    const rule: Rule = { dir, identity };
    if (comment !== undefined) rule.comment = comment;
    return rule;
  });

  // longest prefix first: specific directories win over their parents
  rules.sort((a, b) => b.dir.length - a.dir.length);
  for (let i = 1; i < rules.length; i++) {
    const cur = rules[i] as Rule;
    const prev = rules[i - 1] as Rule;
    if (prev.dir === cur.dir) {
      throw new ModelError(`directory rules conflict: ${cur.dir} is mapped twice`, 'rules');
    }
  }

  const repositories: RepoOverride[] = asArray(raw.repositories, 'repositories').map((r, i) => {
    const path = `repositories[${i}]`;
    const obj = asObject(r, path);
    const p = normaliseRulePath(asString(obj.path, `${path}.path`), opts.home, opts.cwd);
    const identity = asString(obj.identity, `${path}.identity`);
    if (!byName.has(identity)) {
      throw new ModelError(`unknown identity "${identity}"`, `${path}.identity`);
    }
    return { path: p, identity };
  });

  const settingsObj = asObject(raw.settings, 'settings');
  const backupKeep = asOptionalInt(settingsObj.backupKeep, 'settings.backupKeep') ?? DEFAULT_SETTINGS.backupKeep;
  if (backupKeep < 1) throw new ModelError('backupKeep must be >= 1', 'settings.backupKeep');
  const allowRoots = asArray(settingsObj.allowRoots, 'settings.allowRoots').map((v, i) =>
    normaliseRulePath(asString(v, `settings.allowRoots[${i}]`), opts.home, opts.cwd),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    identities,
    sites,
    rules,
    repositories,
    settings: { backupKeep, allowRoots },
  };
}

export function toYaml(profiles: Profiles): Obj {
  const identities: Obj = {};
  const sitesByIdentity = new Map<string, Site[]>();
  for (const site of profiles.sites) {
    const list = sitesByIdentity.get(site.identity) ?? [];
    list.push(site);
    sitesByIdentity.set(site.identity, list);
  }

  for (const identity of profiles.identities) {
    const entry: Obj = {
      user: { name: identity.user.name, email: identity.user.email },
    };
    if (identity.sshKey) entry.sshKey = identity.sshKey;
    if (identity.credentialUsername) entry.credentialUsername = identity.credentialUsername;
    const sites = sitesByIdentity.get(identity.name) ?? [];
    if (sites.length > 0) {
      entry.sites = sites.map((s) => {
        const o: Obj = { host: s.host };
        if (s.port !== undefined) o.port = s.port;
        if (s.user !== undefined) o.user = s.user;
        if (s.sshKey !== undefined) o.sshKey = s.sshKey;
        if (s.alias !== undefined) o.alias = s.alias;
        if (s.sshHostName !== undefined) o.sshHostName = s.sshHostName;
        if (s.alsoRoutes !== undefined) o.alsoRoutes = s.alsoRoutes;
        return o;
      });
    }
    identities[identity.name] = entry;
  }

  const out: Obj = {
    schemaVersion: profiles.schemaVersion,
    identities,
    rules: profiles.rules.map((r) => {
      const o: Obj = { dir: r.dir, identity: r.identity };
      if (r.comment) o.comment = r.comment;
      return o;
    }),
  };
  if (profiles.repositories.length > 0) {
    out.repositories = profiles.repositories.map((r) => ({ path: r.path, identity: r.identity }));
  }
  out.settings = {
    backupKeep: profiles.settings.backupKeep,
    allowRoots: profiles.settings.allowRoots,
  };
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export interface Resolution {
  identity: Identity;
  reason: 'repo' | 'rule' | 'fallback';
  detail: string;
}

/**
 * Pick the identity for a directory or repository path.
 * Repo overrides beat directory rules; the longest matching directory wins.
 *
 * Matching is case sensitive to mirror git's `gitdir:` behaviour — if gs were
 * more permissive than git it would report an identity that git does not use.
 * `realCasePath` keeps stored rules aligned with the casing on disk.
 */
export function resolveIdentity(profiles: Profiles, target: string): Resolution | undefined {
  const normalised = toPosix(target);
  for (const repo of profiles.repositories) {
    if (matchesDir(normalised, repo.path)) {
      const identity = profiles.identities.find((i) => i.name === repo.identity);
      if (identity) return { identity, reason: 'repo', detail: `repository override ${repo.path}` };
    }
  }
  for (const rule of profiles.rules) {
    if (matchesDir(normalised, rule.dir)) {
      const identity = profiles.identities.find((i) => i.name === rule.identity);
      if (identity) return { identity, reason: 'rule', detail: `directory rule ${rule.dir}` };
    }
  }
  return undefined;
}

function matchesDir(targetPosix: string, dir: string): boolean {
  const t = targetPosix.replace(/\/+$/, '');
  const d = dir.replace(/\/+$/, '');
  return t === d || t.startsWith(d + '/');
}

export function sitesFor(profiles: Profiles, identityName: string): Site[] {
  return profiles.sites.filter((s) => s.identity === identityName);
}

export function keyForSite(profiles: Profiles, site: Site): string | undefined {
  return site.sshKey ?? profiles.identities.find((i) => i.name === site.identity)?.sshKey;
}
