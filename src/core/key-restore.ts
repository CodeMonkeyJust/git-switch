/**
 * Restore SSH keys from a snapshot.
 *
 * `gs snapshot export --with-keys` embeds key material in an encrypted
 * snapshot, but importing deliberately does not touch ~/.ssh. Without a way to
 * get the keys back out, `--with-keys` would be a one-way ticket: the data is
 * there and nothing can use it. This module closes that loop with an explicit,
 * opt-in restore.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fs-atomic.ts';

export interface SnapshotKey {
  name: string;
  content: string;
  isPublic: boolean;
}

/** Extract `keys/*` entries from a decrypted snapshot. */
export function keysFromSnapshot(snapshot: {
  files: { path: string; content: string }[];
}): SnapshotKey[] {
  const keys: SnapshotKey[] = [];
  for (const file of snapshot.files) {
    if (!file.path.startsWith('keys/')) continue;
    const name = file.path.slice('keys/'.length);
    if (name === '' || name.includes('/') || name.includes('\\')) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    keys.push({ name, content: file.content, isPublic: name.endsWith('.pub') });
  }
  return keys;
}

export interface RestoreOptions {
  home: string;
  keys: SnapshotKey[];
  /** overwrite keys that already exist */
  force?: boolean;
}

export interface RestoreResult {
  written: string[];
  skipped: string[];
}

/**
 * Write keys into ~/.ssh, refusing to overwrite unless `force`.
 * Private keys are created with mode 600.
 */
export async function restoreKeys(opts: RestoreOptions): Promise<RestoreResult> {
  const dir = path.join(opts.home, '.ssh');
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const written: string[] = [];
  const skipped: string[] = [];

  for (const key of opts.keys) {
    const target = path.join(dir, key.name);
    if (await exists(target)) {
      if (!opts.force) {
        skipped.push(key.name);
        continue;
      }
    }
    await writeFile(target, key.content, { encoding: 'utf8', mode: key.isPublic ? 0o644 : 0o600 });
    if (!key.isPublic) {
      // enforce the mode even when the file already existed
      await chmod(target, 0o600).catch(() => {});
    }
    written.push(key.name);
  }

  return { written, skipped };
}

/** Read a snapshot file's text; kept here so callers do not re-implement it. */
export async function readSnapshotFile(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined);
}
