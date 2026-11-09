import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Cross-platform path helpers.
 *
 * All user-facing paths inside profiles.yaml use forward slashes so that a
 * snapshot written on Windows can be replayed on macOS/Linux. Internally we
 * normalise to the platform separator only at the filesystem boundary.
 */

export const CONFIG_DIR_NAME = 'gs';

/** `~` -> home directory. Expands a leading `~` or `~/` only. */
export function expandHome(input: string, home = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** Collapse the home directory back to `~` for display / portable storage. */
export function contractHome(input: string, home = homedir()): string {
  const normalised = path.resolve(input);
  const normalisedHome = path.resolve(home);
  if (normalised === normalisedHome) return '~';
  if (normalised.startsWith(normalisedHome + path.sep)) {
    return '~/' + toPosix(normalised.slice(normalisedHome.length + 1));
  }
  // outside home: still normalise separators so output is consistent everywhere
  return toPosix(input);
}

/** Windows separators -> forward slashes. */
export function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

export function toPlatform(input: string): string {
  return input.replace(/[\\/]/g, path.sep);
}

/** Windows absolute path: `D:\x`, `D:/x`, or a UNC path `\\server\share`. */
export function isWindowsAbsolute(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input);
}

/** Absolute in any supported convention, regardless of the host OS. */
function isAbsoluteAnywhere(input: string): boolean {
  return path.isAbsolute(input) || isWindowsAbsolute(input);
}

/**
 * Absolute path with forward slashes and no trailing separator.
 * Used for storing directory rules in profiles.yaml.
 *
 * A Windows path is recognised even when running on Linux: snapshots move
 * between machines, so `D:/code/x` must not be mistaken for a relative path and
 * joined onto the current directory.
 */
export function normaliseRulePath(input: string, home = homedir(), cwd = process.cwd()): string {
  const expanded = expandHome(input, home);

  if (isWindowsAbsolute(expanded)) {
    // leave the drive/UNC prefix alone; only normalise separators and shape
    const posix = toPosix(expanded).replace(/\/{2,}/g, '/').replace(/^([A-Za-z]:)\//, '$1/');
    const trimmed = posix.length > 3 ? posix.replace(/\/+$/, '') : posix;
    return trimmed;
  }

  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const posix = toPosix(path.normalize(absolute));
  const trimmed = posix.length > 1 ? posix.replace(/\/+$/, '') : posix;
  return trimmed;
}

/**
 * `gitdir:` match value for an `includeIf` section.
 *
 * Verified against git for Windows: the value MUST be an absolute path with
 * forward slashes and MUST end with a trailing slash, otherwise git does not
 * match the prefix at all.
 */
export function gitdirPattern(rulePath: string): string {
  const posix = toPosix(rulePath);
  return posix.endsWith('/') ? posix : posix + '/';
}

export interface GsPaths {
  home: string;
  configDir: string;
  profiles: string;
  identitiesDir: string;
  backupsDir: string;
  snapshotsDir: string;
  stateFile: string;
  sshDir: string;
  sshConfig: string;
  globalGitConfig: string;
}

export function gsPaths(home = homedir()): GsPaths {
  const configDir = path.join(home, '.config', CONFIG_DIR_NAME);
  return {
    home,
    configDir,
    profiles: path.join(configDir, 'profiles.yaml'),
    identitiesDir: path.join(configDir, 'identities'),
    backupsDir: path.join(configDir, 'backups'),
    snapshotsDir: path.join(configDir, 'snapshots'),
    stateFile: path.join(configDir, 'state.json'),
    sshDir: path.join(home, '.ssh'),
    sshConfig: path.join(home, '.ssh', 'config'),
    globalGitConfig: path.join(home, '.gitconfig'),
  };
}

/**
 * Re-align a rule path with the casing that exists on disk.
 *
 * git's `gitdir:` match is case sensitive even on Windows (`gitdir/i:` is not
 * honoured by every build), while `gs` matches rules case-insensitively. Left
 * alone, `/code/github` as a rule would never match a repository under
 * `/code/GitHub`, and `gs` would claim the rule applies while git disagrees.
 * Walking the real path removes that discrepancy at the source.
 */
export async function realCasePath(input: string, home = homedir()): Promise<string> {
  const absolute = normaliseRulePath(input, home);
  if (process.platform !== 'win32' && process.platform !== 'darwin') return absolute;

  const parts = absolute.split('/');
  let current = parts[0] === '' ? '/' : (parts[0] as string) + '/';
  const rest = parts[0] === '' ? parts.slice(1) : parts.slice(1);

  for (const segment of rest) {
    if (segment === '') continue;
    const candidate = current.endsWith('/') ? current + segment : `${current}/${segment}`;
    let matched: string | undefined;
    try {
      const entries = await readdir(current === '' ? '/' : current, { withFileTypes: true });
      const exact = entries.find((e) => e.name === segment);
      if (exact) {
        matched = exact.name;
      } else {
        const lower = segment.toLowerCase();
        matched = entries.find((e) => e.name.toLowerCase() === lower)?.name;
      }
    } catch {
      return absolute;
    }
    if (!matched) return absolute;
    current = candidate.slice(0, candidate.length - segment.length) + matched;
  }
  return toPosix(current);
}
