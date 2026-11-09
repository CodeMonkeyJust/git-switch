import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Durable, atomic file writes: temp file -> fsync -> rename. */
export async function writeFileAtomic(target: string, content: string, eolPreserve = true): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.gs-tmp-${randomBytes(6).toString('hex')}`);
  const data = eolPreserve ? content : content;
  let handle;
  try {
    handle = await open(tmp, 'w');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw describeWriteError(err, target);
  }
  await handle.close();

  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw describeWriteError(err, target);
  }
}

/**
 * Rewrite an fs error so it names the file the user asked to write, not the
 * internal temp file used for the atomic swap.
 */
function describeWriteError(err: unknown, target: string): Error {
  const code = (err as { code?: string }).code;
  const reason =
    code === 'EPERM' || code === 'EACCES'
      ? 'permission denied — is the file read-only or owned by another user?'
      : code === 'EBUSY'
        ? 'file is in use by another process'
        : code === 'ENOSPC'
          ? 'no space left on device'
          : code === 'EROFS'
            ? 'filesystem is read-only'
            : ((err as Error).message ?? 'write failed');
  const wrapped = new Error(`cannot write ${target}: ${reason}`);
  if (code) (wrapped as Error & { code?: string }).code = code;
  return wrapped;
}

export async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw err;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function statIfExists(file: string) {
  try {
    return await stat(file);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw err;
  }
}

/** Copy `source` to `dest` only when it exists; returns false when missing. */
export async function backupFile(source: string, dest: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
  return true;
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

export function timestamp(date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}
