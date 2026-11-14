import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileIfExists, writeFileAtomic } from '../util/fs-atomic.ts';

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

export interface GlobalIdentity {
  name?: string;
  email?: string;
  /** `~/.gitconfig`, or the file the identity actually came from */
  origin?: string;
}

/** `git` invoked without a shell, resolved once. */
function runGit(args: string[], options: { env: NodeJS.ProcessEnv; timeout?: number; windowsHide?: boolean }) {
  return promisify(execFile)('git', args, options);
}

/**
 * Read the identity git falls back to outside every rule.
 *
 * `gs list` tells the user "no rule matched, this falls back to the global
 * identity" — without saying *which* identity that is, the message is not
 * actionable. A personal repo silently committing with a work address is exactly
 * the failure mode this tool exists to prevent.
 */
export async function readGlobalIdentity(home = homedir()): Promise<GlobalIdentity | undefined> {
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' };
  try {
    const { stdout } = await runGit(['config', '--global', '--list'], {
      env,
      timeout: 5000,
      windowsHide: true,
    });
    let name: string | undefined;
    let email: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index === -1) continue;
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      if (key === 'user.name' && value !== '') name = value;
      if (key === 'user.email' && value !== '') email = value;
    }
    if (name === undefined && email === undefined) return undefined;
    return {
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
      origin: contractHome(path.join(home, '.gitconfig'), home),
    };
  } catch {
    return undefined;
  }
}

/** `zhulj <me@example.com>` or a partial value when only one half is set. */
export function formatIdentity(identity: GlobalIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  if (identity.name && identity.email) return `${identity.name} <${identity.email}>`;
  return identity.name ?? identity.email;
}

/**
 * Write `user.name` / `user.email` into ~/.gitconfig.
 *
 * The global identity lives outside the gs managed block, so this edits the file
 * directly rather than going through `apply`. Everything else in the file —
 * comments, sections, the managed block itself — is preserved: only the `[user]`
 * section's two keys are rewritten, and the section is created when absent.
 *
 * Returns the previous values so the caller can show a diff and offer a rollback.
 */
export async function writeGlobalIdentity(
  home: string,
  values: { name?: string | undefined; email?: string | undefined },
): Promise<{ before: GlobalIdentity | undefined; file: string }> {
  const file = path.join(home, '.gitconfig');
  const before = await readGlobalIdentity(home);
  const original = (await readFileIfExists(file)) ?? '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';

  const updated = setUserSection(original, values, eol);
  await writeFileAtomic(file, updated);
  return { before, file };
}

/**
 * Replace or insert `name` / `email` inside the `[user]` section.
 * A `user.name = …` line inside another section is not touched because sections
 * are tracked while scanning.
 */
export function setUserSection(
  text: string,
  values: { name?: string | undefined; email?: string | undefined },
  eol = '\n',
): string {
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const wanted: [string, string | undefined][] = [
    ['name', values.name],
    ['email', values.email],
  ];

  // locate the [user] section
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('[')) continue;
    if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
    if (/^\[\s*user\s*\]$/i.test(line)) sectionStart = i;
  }

  if (sectionStart === -1) {
    // append a new section, keeping the file's trailing newline convention
    const block = ['[user]'];
    for (const [key, value] of wanted) {
      if (value !== undefined) block.push(`\t${key} = ${value}`);
    }
    const merged = lines.length === 0 ? block : [...lines, '', ...block];
    return merged.join(eol) + eol;
  }

  const section = lines.slice(sectionStart + 1, sectionEnd);
  const handled = new Set<string>();
  const rewritten = section.map((line) => {
    const match = /^(\s*)(name|email)(\s*=).*$/i.exec(line);
    if (!match) return line;
    const key = (match[2] ?? '').toLowerCase();
    const value = key === 'name' ? values.name : values.email;
    if (value === undefined) return line; // leave untouched
    handled.add(key);
    return `${match[1]}${key}${match[3]} ${value}`;
  });

  for (const [key, value] of wanted) {
    if (value !== undefined && !handled.has(key)) rewritten.push(`\t${key} = ${value}`);
  }

  const merged = [...lines.slice(0, sectionStart + 1), ...rewritten, ...lines.slice(sectionEnd)];
  return merged.join(eol);
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
