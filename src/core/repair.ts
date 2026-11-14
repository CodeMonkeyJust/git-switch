/**
 * Repair a profile field that failed validation.
 *
 * A user pastes `http://git.example.com:9090/` into the site's host field and the
 * whole profile stops loading. Telling them the YAML path is not enough: they
 * opened a GUI precisely because they do not want to edit YAML. This module
 * recognises the common mistakes and rewrites the file in place, keeping
 * everything else byte-for-byte.
 */

export interface RepairSuggestion {
  /** The field path reported by the validator, e.g. `identities.a.sites[0].host` */
  path: string;
  /** Human-readable description of what was wrong */
  problem: string;
  /** Whether an automatic fix is available */
  fixable: boolean;
  /** What the value would become */
  fixed?: string;
  /** Extra field this fix also writes, e.g. a port extracted from a URL */
  extra?: { path: string; value: string };
}

/** Split a URL-ish host into host and port. */
export function splitHostInput(input: string): { host: string; port?: string } {
  let rest = input.trim();

  // strip scheme
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // strip userinfo
  rest = rest.replace(/^[^@/]+@/, '');
  // strip path / query / fragment
  rest = rest.split('/')[0] ?? '';
  rest = rest.split('?')[0] ?? '';

  // `git@host:owner/repo.git` style — the part before ':' is a host, the rest a path
  if (rest.includes(':') && !/^[^:]+:\d+$/.test(rest)) {
    rest = rest.split(':')[0] ?? '';
  }

  const portMatch = /^(.*):(\d+)$/.exec(rest);
  if (portMatch) {
    const port = portMatch[2];
    return { host: (portMatch[1] ?? '').trim(), ...(port ? { port } : {}) };
  }
  return { host: rest.trim() };
}

/** True when the value is already a bare host. */
export function isBareHost(value: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value.trim());
}

/**
 * Inspect a validation failure and propose a repair.
 * Works from the error message because that is what the server persists.
 */
export function suggestRepair(errorMessage: string): RepairSuggestion | undefined {
  const match = /^(?<path>[A-Za-z0-9_.\[\]]+):\s*not a valid host:\s*(?<value>.*)$/.exec(errorMessage.trim());
  if (!match?.groups) return undefined;

  const field = match.groups.path ?? '';
  const value = (match.groups.value ?? '').trim();
  const { host, port } = splitHostInput(value);

  if (isBareHost(host)) {
    // the host part is valid; the URL/port wrapper is what broke it
    const basePath = field.replace(/\.host$/, '');
    return {
      path: field,
      problem: value,
      fixable: true,
      fixed: host,
      ...(port !== undefined ? { extra: { path: `${basePath}.port`, value: port } } : {}),
    };
  }

  // Scrub whatever remains; if nothing legal is left there is no safe guess
  const cleaned = host.replace(/[^A-Za-z0-9.-]/g, '').replace(/^[.-]+|[.-]+$/g, '');
  if (cleaned === '' || !isBareHost(cleaned)) {
    return { path: field, problem: value, fixable: false };
  }
  return { path: field, problem: value, fixable: true, fixed: cleaned };
}

/**
 * Rewrite the offending value inside the profile text.
 *
 * Deliberately text-based: the file may not even parse (that is often the
 * problem), so it cannot be round-tripped through the model.
 */
export function applyRepair(text: string, suggestion: RepairSuggestion): string {
  if (!suggestion.fixable || suggestion.fixed === undefined) return text;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  // the validator reports either `identities.<name>` or `identity.<name>`
  const identityName = /identit(?:y|ies)\.(?<name>[^.]+)\./i.exec(suggestion.path)?.groups?.name ?? '';
  const siteIndex = Number(/sites\[(?<index>\d+)\]/.exec(suggestion.path)?.groups?.index ?? '-1');

  /*
   * Walk the YAML keeping a small state machine:
   *   inIdentities → we saw the top-level `identities:` key
   *   inIdentity   → the current 2-space key is the one we want
   *   inSites      → we saw `sites:` inside that identity
   *   siteIndex    → how many `- ` items have started
   * A top-level key (indent 0) resets everything.
   */
  let inIdentity = false;
  let inSites = false;
  let sitesIndent = -1;
  let seenSites = -1;
  let hostLine = -1;
  let hostIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      inIdentity = false;
      inSites = false;
      sitesIndent = -1;
      seenSites = -1;
      continue;
    }

    if (indent === 2 && !trimmed.startsWith('-')) {
      inIdentity = trimmed.endsWith(':') && trimmed.slice(0, -1).trim() === identityName;
      inSites = false;
      sitesIndent = -1;
      seenSites = -1;
      continue;
    }

    if (!inIdentity) continue;

    if (trimmed === 'sites:' || trimmed.startsWith('sites:')) {
      inSites = true;
      sitesIndent = indent;
      seenSites = -1;
      continue;
    }

    if (!inSites) continue;

    // a list item begins with "- "
    if (trimmed.startsWith('-')) {
      seenSites += 1;
      if (seenSites === siteIndex) {
        const item = trimmed.slice(1).trim();
        // `- host: value` on the same line
        if (/^host\s*:/.test(item)) {
          hostLine = i;
          hostIndent = indent;
          break;
        }
        continue;
      }
      continue;
    }

    // nested key of the current item
    if (seenSites === siteIndex && indent > sitesIndent && /^host\s*:/.test(trimmed)) {
      hostLine = i;
      hostIndent = indent;
      break;
    }
  }

  if (hostLine === -1) return text;

  const original = lines[hostLine] ?? '';
  const isInline = original.trim().startsWith('-');
  const pad = ' '.repeat(isInline ? hostIndent + 2 : hostIndent);
  lines[hostLine] = isInline
    ? `${' '.repeat(hostIndent)}- host: ${suggestion.fixed}`
    : `${pad}host: ${suggestion.fixed}`;

  // the port extracted from the URL must not be dropped silently
  if (suggestion.extra) {
    const insertAt = hostLine + 1;
    // avoid duplicating an existing port key for this site
    const nextLine = (lines[insertAt] ?? '').trim();
    if (!/^port\s*:/.test(nextLine)) {
      lines.splice(insertAt, 0, `${pad}port: ${suggestion.extra.value}`);
    }
  }

  return lines.join(eol);
}
