/**
 * Render the managed block for ~/.ssh/config.
 *
 * Design rules (deliberate, see docs/security-model.md):
 *  - Every site gets a dedicated Host alias with `IdentitiesOnly yes` so ssh
 *    never falls back to some other key.
 *  - We only ever emit keys that belong to the alias: HostName, Port, User,
 *    IdentityFile, IdentitiesOnly. Anything else would change ssh semantics
 *    outside our remit.
 *  - Plain `Host <real-host>` entries are NOT emitted, because the user's own
 *    config may already define them and a global entry would apply to every
 *    repository on the machine.
 */

import type { Profiles, Site } from '../model.ts';
import { keyForSite } from '../model.ts';

export interface RenderedHost {
  alias: string;
  hostName: string;
  port?: number;
  user: string;
  keyName: string | undefined;
}

export function aliasForSite(site: Site): string {
  return site.alias ?? `${sanitise(site.host)}-gs`;
}

function sanitise(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

export interface BuildHostsResult {
  hosts: RenderedHost[];
  /** sites skipped because no key was configured for them */
  skipped: { host: string; identity: string }[];
}

/**
 * Build the Host blocks for every site that has a key.
 *
 * A site without `IdentityFile` is skipped rather than rendered: `IdentitiesOnly
 * yes` with no `IdentityFile` falls back to ssh's default keys (`id_rsa`,
 * `id_ed25519`, …), which is exactly the "wrong key is tried" failure gs exists
 * to prevent. Skipping keeps the managed block honest; `gs doctor` reports the
 * missing key.
 */
export function buildHostsDetailed(profiles: Profiles): BuildHostsResult {
  const hosts: RenderedHost[] = [];
  const skipped: { host: string; identity: string }[] = [];
  const seen = new Map<string, string>();

  for (const site of profiles.sites) {
    const key = keyForSite(profiles, site);
    if (!key) {
      skipped.push({ host: site.host, identity: site.identity });
      continue;
    }

    const alias = aliasForSite(site);
    // `host` is the real Git host; sshHostName is the endpoint we actually dial.
    const hostName = site.sshHostName ?? site.host;
    const existing = seen.get(alias);
    if (existing) {
      throw new Error(`duplicate ssh alias "${alias}" for ${existing} and ${hostName}`);
    }
    seen.set(alias, hostName);

    const host: RenderedHost = {
      alias,
      hostName,
      user: site.user ?? 'git',
      keyName: key,
    };
    if (site.port !== undefined) host.port = site.port;
    hosts.push(host);
  }

  return { hosts, skipped };
}

export function buildHosts(profiles: Profiles): RenderedHost[] {
  return buildHostsDetailed(profiles).hosts;
}

export function renderSshBlock(hosts: RenderedHost[]): string {
  return hosts
    .map((host) => {
      const lines = [`Host ${host.alias}`, `\tHostName ${host.hostName}`];
      if (host.port !== undefined) lines.push(`\tPort ${host.port}`);
      lines.push(`\tUser ${host.user}`);
      if (host.keyName) lines.push(`\tIdentityFile ~/.ssh/${host.keyName}`);
      lines.push(`\tIdentitiesOnly yes`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Maps a real Git host to the alias that gs routes it through, for `insteadOf`.
 *
 * Only real Git hosts are routed. SSH endpoints (`ssh.github.com`) must never
 * appear here: they are how ssh connects, not how a remote is written.
 *
 * Sites without a key are skipped: their Host block is not generated, so routing
 * a remote to that alias would send ssh to a host that does not exist.
 */
export function aliasesForIdentity(profiles: Profiles, identityName: string): { alias: string; hosts: string[] }[] {
  const out: { alias: string; hosts: string[] }[] = [];
  for (const site of profiles.sites) {
    if (site.identity !== identityName) continue;
    if (!keyForSite(profiles, site)) continue;
    const hosts = [site.host, ...(site.alsoRoutes ?? [])];
    out.push({ alias: aliasForSite(site), hosts });
  }
  return out;
}
