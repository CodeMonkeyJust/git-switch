import { homedir } from 'node:os';
import path from 'node:path';
import { loadProfiles } from '../core/profiles.ts';
import { resolveIdentity, sitesFor } from '../core/model.ts';
import { gsPaths, contractHome, normaliseRulePath } from '../core/paths.ts';
import type { Logger } from '../util/log.ts';

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

  logger.info('identities');
  const width = Math.max(10, ...profiles.identities.map((i) => i.name.length));
  for (const identity of result.identities) {
    const sites = identity.sites.map((s) => (s.port ? `${s.host}:${s.port}` : s.host)).join(', ');
    logger.dim(
      `  ${identity.name.padEnd(width)}  ${identity.name_email.padEnd(34)}  ${(identity.sshKey ?? '-').padEnd(20)}  ${sites || '-'}`,
    );
  }

  if (result.rules.length > 0) {
    logger.info('directory rules');
    for (const rule of result.rules) logger.dim(`  ${rule.dir}  ->  ${rule.identity}`);
  }

  if (result.repositories.length > 0) {
    logger.info('repository overrides');
    for (const repo of result.repositories) logger.dim(`  ${repo.path}  ->  ${repo.identity}`);
  }

  if (result.resolved) {
    logger.info('current directory');
    logger.dim(`  ${result.resolved.target}  ->  ${result.resolved.identity}  (${result.resolved.detail})`);
  } else {
    logger.info('current directory');
    logger.warn(`  ${contract(cwd)}  ->  no matching rule (falls back to the global identity)`);
  }

  logger.dim(`profile: ${contract(gsPaths(home).profiles)}`);
  return 0;
}

export { path };
