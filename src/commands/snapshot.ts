import { mkdir, readFile } from 'node:fs/promises';
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
      opts.logger.error('usage: gs snapshot <export|import> <file>');
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
      logger.error(`${target} already exists; pass --force to overwrite`);
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

  logger.ok(`wrote ${target}`);
  logger.dim(
    `   ${snapshot.files.length} files · ${profiles.identities.length} identities · ${profiles.rules.length} rules`,
  );
  if (snapshot.manifest.containsKeys) {
    logger.warn('contains PRIVATE KEYS and is encrypted; keep the passphrase safe');
  } else {
    logger.dim('   no private keys included (--with-keys adds them, encrypted)');
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
    logger.error(`cannot read ${opts.target}`);
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
    logger.error('a profile already exists at ~/.config/gs/profiles.yaml; pass --force to replace it');
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

  logger.ok(`imported ${profiles.identities.length} identities and ${profiles.rules.length} rules`);
  for (const [from, to] of remaps) logger.dim(`   remapped ${from} -> ${to}`);

  if (snapshot.manifest.containsKeys) {
    logger.warn('the snapshot holds private keys, which gs does NOT write to ~/.ssh');
    logger.dim('   restore them yourself, or create fresh keys per machine');
  }

  logger.dim('next: gs doctor   then   gs diff   then   gs apply');
  return 0;
}
