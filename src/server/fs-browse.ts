/**
 * Restricted directory browsing for the GUI.
 *
 * A browser cannot hand a real filesystem path to the server, so the rule matrix
 * needs a server-side picker. It is deliberately narrow: only directories under
 * explicitly allowed roots, symlinks resolved first, `..` rejected outright.
 */

import { existsSync } from 'node:fs';
import { realpath, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { toPosix } from '../core/paths.ts';

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface BrowseResult {
  dir: string;
  parent?: string;
  roots: string[];
  entries: BrowseEntry[];
  error?: string;
}

export interface BrowseOptions {
  home: string;
  allowRoots: string[];
  /** requested directory; defaults to home */
  dir?: string;
  limit?: number;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Normalise and prove the target lives under one of the allowed roots. */
export async function resolveAllowedDir(requested: string, roots: string[]): Promise<string | undefined> {
  let candidate: string;
  try {
    candidate = await realpath(requested);
  } catch {
    return undefined;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isInside(candidate, realRoot)) return candidate;
  }
  return undefined;
}

export async function browse(opts: BrowseOptions): Promise<BrowseResult> {
  const limit = opts.limit ?? 200;
  const requested = opts.dir;
  const fallback = opts.home;

  // reject traversal attempts before touching the fs
  if (requested !== undefined && requested.includes('..')) {
    return { dir: requested, roots: opts.allowRoots, entries: [], error: 'path must not contain ".."' };
  }

  const roots = [opts.home, ...opts.allowRoots];
  const target = requested ?? fallback;
  const dir = await resolveAllowedDir(target, roots);
  if (!dir) {
    return {
      dir: toPosix(target),
      roots: roots.map(toPosix),
      entries: [],
      error: 'directory is outside the allowed roots',
    };
  }

  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) {
    return { dir: toPosix(dir), roots: roots.map(toPosix), entries: [], error: 'not a directory' };
  }

  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
    const full = path.join(dir, dirent.name);
    entries.push({ name: dirent.name, path: toPosix(full), isRepo: isRepoDir(full) });
    if (entries.length >= limit) break;
  }
  entries.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));

  const parent = isInside(path.dirname(dir), opts.home) || opts.allowRoots.some((r) => isInside(path.dirname(dir), r))
    ? toPosix(path.dirname(dir))
    : undefined;

  return {
    dir: toPosix(dir),
    ...(parent ? { parent } : {}),
    roots: roots.map(toPosix),
    entries,
  };
}

function isRepoDir(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

export { homedir };
