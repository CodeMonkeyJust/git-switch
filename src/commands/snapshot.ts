import { mkdir, readFile } from 'node:fs/promises';
import { t } from '../core/i18n.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadProfiles, profilesExist, saveProfiles } from '../core/profiles.ts';
import {
  buildSnapshot,
  encryptSnapshot,
  decryptSnapshot,
  verifySnapshot,
  parseRemap,
  remapProfiles,
  assertNoPlaintextKeys,
} from '../core/snapshot.ts';
import { writeFileAtomic } from '../util/fs-atomic.ts';
import type { Logger } from '../util/log.ts';

export interface SnapshotOptions {
  home?: string;
  subcommand: string | undefined;
  target: string | undefined;
  remaps?: string[];
  withKeys?: boolean;
  passphrase?: string;
  force?: boolean;
  json?: boolean;
  logger: Logger;
}

async function promptPassphrase(message: string): Promise<string> {
  // an environment variable keeps scripts non-interactive; it is never logged
  const fromEnv = process.env.GS_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error('no passphrase available: set GS_PASSPHRASE or run interactively');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${message}: `);
  } finally {
    rl.close();
  }
}

export async function snapshotCommand(opts: SnapshotOptions): Promise<number> {
  const home = opts.home ?? homedir();
  switch (opts.subcommand) {
    case 'export':
      return exportSnapshot(opts, home);
    case 'import':
      return importSnapshot(opts, home);
    default:
      opts.logger.error(t('snapshot.usage'));
      return 2;
  }
}

async function exportSnapshot(opts: SnapshotOptions, home: string): Promise<number> {
  const { logger } = opts;
  const profiles = await loadProfiles(home);

  const target =
    opts.target ?? path.join(home, '.config', 'gs', 'snapshots', 'gs-snapshot.gsnap');

  const snapshot = await buildSnapshot({ home, profiles, includeKeys: opts.withKeys === true });

  let output: string;
  if (snapshot.manifest.containsKeys) {
    const passphrase =
      opts.passphrase ?? (await promptPassphrase('passphrase for the private keys').catch((err: Error) => {
        throw err;
      }));
    output = await encryptSnapshot(snapshot, passphrase);
  } else {
    assertNoPlaintextKeys(snapshot);
    output = JSON.stringify(snapshot, null, 2);
  }

  if (!opts.force) {
    const existing = await readFile(target, 'utf8').catch(() => undefined);
    if (existing !== undefined) {
      logger.error(t('snapshot.exists', target));
      return 2;
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, output);

  if (logger.isJson) {
    logger.json({
      path: target,
      files: snapshot.files.length,
      containsKeys: snapshot.manifest.containsKeys,
      identities: profiles.identities.length,
      rules: profiles.rules.length,
    });
    return 0;
  }

  logger.ok(t('snapshot.exported', target));
  logger.dim(`   ${t('snapshot.exportSummary', snapshot.files.length, profiles.identities.length, profiles.rules.length)}`);
  if (snapshot.manifest.containsKeys) {
    logger.warn(t('snapshot.hasKeys'));
  } else {
    logger.dim(`   ${t('snapshot.noKeys')}`);
  }
  return 0;
}

async function importSnapshot(opts: SnapshotOptions, home: string): Promise<number> {
  const { logger } = opts;
  if (!opts.target) {
    logger.error('usage: gs snapshot import <file> [--remap OLD=NEW] [--force]');
    return 2;
  }

  const text = await readFile(opts.target, 'utf8').catch(() => undefined);
  if (text === undefined) {
    logger.error(t('snapshot.cannotRead', String(opts.target)));
    return 2;
  }

  // encrypted envelopes are JSON with a "magic" field; plain snapshots have "files"
  const looksEncrypted = text.trimStart().startsWith('{') && text.includes('"magic"');
  let snapshot;
  try {
    if (looksEncrypted) {
      const passphrase = opts.passphrase ?? (await promptPassphrase('passphrase'));
      snapshot = await decryptSnapshot(text, passphrase);
    } else {
      snapshot = JSON.parse(text);
    }
  } catch (err) {
    logger.error((err as Error).message);
    return 2;
  }

  const verdict = verifySnapshot(snapshot, home);
  if (!verdict.ok) {
    for (const problem of verdict.problems) logger.error(problem);
    return 2;
  }
  if (!verdict.profiles) {
    logger.error('snapshot did not yield a usable profile');
    return 2;
  }

  let remaps: [string, string][] = [];
  try {
    remaps = parseRemap(opts.remaps ?? []);
  } catch (err) {
    logger.error((err as Error).message);
    return 2;
  }

  const profiles = remapProfiles(verdict.profiles, remaps);

  if ((await profilesExist(home)) && !opts.force) {
    logger.error(t('snapshot.profileExists'));
    return 2;
  }

  await saveProfiles(home, profiles);

  if (logger.isJson) {
    logger.json({
      imported: true,
      identities: profiles.identities.length,
      rules: profiles.rules.length,
      remapped: remaps.length,
      hasKeys: snapshot.manifest.containsKeys,
    });
    return 0;
  }

  logger.ok(t('snapshot.imported', profiles.identities.length, profiles.rules.length));
  for (const [from, to] of remaps) logger.dim(`   ${t('snapshot.remapped', from, to)}`);

  if (snapshot.manifest.containsKeys) {
    logger.warn(t('snapshot.keysNotWritten'));
    logger.dim(`   ${t('snapshot.keysRestoreHint', String(opts.target))}`);
  }

  logger.dim(t('snapshot.next'));
  return 0;
}
