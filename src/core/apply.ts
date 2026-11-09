/**
 * Apply a plan to disk.
 *
 * Safety properties, in order of importance:
 *  1. Refuse to overwrite a managed block that was edited by hand after the plan
 *     was computed (the user's edit would be silently destroyed).
 *  2. Take a timestamped backup of every file before touching it.
 *  3. Never write outside the planned file set.
 *  4. Write atomically, so an interrupted run cannot leave a truncated config.
 */

import path from 'node:path';
import type { FileOp, Plan } from './plan.ts';
import { gsPaths } from './paths.ts';
import { backupFile, readFileIfExists, timestamp, writeFileAtomic } from '../util/fs-atomic.ts';

export interface ApplyOptions {
  home: string;
  /** overwrite managed blocks that were edited by hand */
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
}

export interface ApplyResult {
  written: string[];
  backups: string[];
  skipped: string[];
  errors: { file: string; message: string }[];
}

export class HandEditError extends Error {
  readonly files: string[];

  constructor(files: string[]) {
    super(
      `files changed since planning: ${files.join(', ')}. ` +
        `Re-run with --force to overwrite, or move those edits into profiles.yaml.`,
    );
    this.name = 'HandEditError';
    this.files = files;
  }
}

export async function apply(plan: Plan, opts: ApplyOptions): Promise<ApplyResult> {
  const paths = gsPaths(opts.home);
  const stamp = timestamp(opts.now ?? new Date());
  const result: ApplyResult = { written: [], backups: [], skipped: [], errors: [] };

  const pending = plan.ops.filter((op) => op.kind !== 'unchanged');
  if (pending.length === 0) return result;

  // 1. every target must still hold the content the plan was computed from
  const stale: string[] = [];
  for (const op of pending) {
    const current = await readFileIfExists(op.file);
    const expected = op.before ?? (op.kind === 'create' ? undefined : undefined);
    if (op.kind === 'create') {
      if (current !== undefined) stale.push(op.label);
      continue;
    }
    if ((current ?? '') !== (expected ?? '')) stale.push(op.label);
  }
  if (stale.length > 0 && !opts.force) throw new HandEditError(stale);
  if (opts.dryRun) return result;

  // 2. back up, then write
  for (const op of pending) {
    try {
      const backupPath = path.join(paths.backupsDir, backupName(op.file, paths.home, stamp));
      if (await backupFile(op.file, backupPath)) result.backups.push(backupPath);

      if (op.kind === 'delete') {
        await writeFileAtomic(op.file, '');
        result.written.push(op.label);
        continue;
      }
      await writeFileAtomic(op.file, op.after ?? '');
      result.written.push(op.label);
    } catch (err) {
      result.errors.push({ file: op.label, message: (err as Error).message });
    }
  }

  return result;
}

/**
 * Human-readable backup name: `gitconfig.20261109-121222.bak`, or
 * `ssh-config.…bak`. The full path is deliberately not encoded — a wall of
 * escaped separators tells the user nothing.
 */
export function backupName(file: string, home: string, stamp: string): string {
  const relative = path.relative(home, file);
  const meaningful = relative.startsWith('..') ? path.basename(file) : relative;
  const slug = relative.startsWith('..')
    ? meaningful
    : meaningful.replace(/^\./, '').replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
  return `${slug || 'file'}.${stamp}.bak`;
}

export type { FileOp };
