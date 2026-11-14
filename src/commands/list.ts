import { homedir } from 'node:os';
import path from 'node:path';
import { loadProfiles } from '../core/profiles.ts';
import { resolveIdentity, sitesFor } from '../core/model.ts';
import { gsPaths, contractHome, normaliseRulePath, readGlobalIdentity, formatIdentity } from '../core/paths.ts';
import type { Logger } from '../util/log.ts';
import { t } from '../core/i18n.ts';

export interface ListOptions {
  home?: string;
  cwd?: string;
  json?: boolean;
  logger: Logger;
}

export interface ListResult {
  identities: {
    name: string;
    name_email: string;
    email: string;
    sshKey?: string;
    sites: { host: string; port?: number; identity: string }[];
  }[];
  rules: { dir: string; identity: string }[];
  repositories: { path: string; identity: string }[];
  resolved?: { target: string; identity: string; reason: string; detail: string };
}

export async function listCommand(opts: ListOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const profiles = await loadProfiles(home, cwd);
  const contract = (p: string) => contractHome(p, home);
  const { logger } = opts;

  const current = resolveIdentity(profiles, normaliseRulePath(cwd, home, cwd));

  const result: ListResult = {
    identities: profiles.identities.map((i) => ({
      name: i.name,
      name_email: `${i.user.name} <${i.user.email}>`,
      email: i.user.email,
      ...(i.sshKey ? { sshKey: i.sshKey } : {}),
      sites: sitesFor(profiles, i.name).map((s) => ({
        host: s.host,
        ...(s.port !== undefined ? { port: s.port } : {}),
        identity: s.identity,
      })),
    })),
    rules: profiles.rules.map((r) => ({ dir: contract(r.dir), identity: r.identity })),
    repositories: profiles.repositories.map((r) => ({ path: contract(r.path), identity: r.identity })),
    ...(current
      ? {
          resolved: {
            target: contract(cwd),
            identity: current.identity.name,
            reason: current.reason,
            detail: current.detail,
          },
        }
      : {}),
  };

  if (logger.isJson) {
    logger.json(result);
    return 0;
  }

  logger.info(t('list.identities'));
  const width = Math.max(10, ...profiles.identities.map((i) => i.name.length));
  for (const identity of result.identities) {
    const sites = identity.sites.map((s) => (s.port ? `${s.host}:${s.port}` : s.host)).join(', ');
    logger.dim(
      `  ${identity.name.padEnd(width)}  ${identity.name_email.padEnd(34)}  ${(identity.sshKey ?? '-').padEnd(20)}  ${sites || '-'}`,
    );
  }

  if (result.rules.length > 0) {
    logger.info(t('list.rules'));
    for (const rule of result.rules) logger.dim(`  ${rule.dir}  ->  ${rule.identity}`);
  }

  if (result.repositories.length > 0) {
    logger.info(t('list.repositories'));
    for (const repo of result.repositories) logger.dim(`  ${repo.path}  ->  ${repo.identity}`);
  }

  if (result.resolved) {
    logger.info(t('list.currentDir'));
    logger.dim(`  ${result.resolved.target}  ->  ${result.resolved.identity}  (${result.resolved.detail})`);
  } else {
    logger.info(t('list.currentDir'));
    logger.warn(`  ${t('list.noRule', contract(cwd))}`);
    // Say which identity it falls back TO: a personal repo committing with a work
    // address is the exact failure this tool exists to prevent.
    const globalIdentity = formatIdentity(await readGlobalIdentity(home));
    if (globalIdentity) {
      logger.warn(`  ${t('list.fallsBackTo', globalIdentity)}`);
    } else {
      logger.warn(`  ${t('list.fallsBackToUnset')}`);
    }
  }

  // Always state the global identity: it applies to everything without a rule.
  if (result.resolved) {
    const globalIdentity = formatIdentity(await readGlobalIdentity(home));
    logger.info(t('list.globalIdentity'));
    logger.dim(`  ${globalIdentity ?? t('list.globalUnset')}`);
  }

  logger.dim(t('list.profile', contract(gsPaths(home).profiles)));
  return 0;
}

export { path };
