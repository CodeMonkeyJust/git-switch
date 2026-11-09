import { homedir } from 'node:os';
import { t } from '../core/i18n.ts';
import { loadProfiles } from '../core/profiles.ts';
import { generateKey, listKeys, publicKeyFor, copyToClipboard } from '../core/keys.ts';
import { keysFromSnapshot, restoreKeys, readSnapshotFile } from '../core/key-restore.ts';
import { decryptSnapshot } from '../core/snapshot.ts';
import type { Logger } from '../util/log.ts';

export interface KeyOptions {
  home?: string;
  subcommand: string | undefined;
  target: string | undefined;
  /** overwrite existing keys when restoring */
  force?: boolean;
  /** passphrase for an encrypted snapshot (falls back to GS_PASSPHRASE) */
  passphrase?: string;
  json?: boolean;
  logger: Logger;
}

/** Prompt for a passphrase without echoing it into shell history. */
async function askPassphrase(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('no passphrase available: set GS_PASSPHRASE or run interactively');
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${message}: `);
  } finally {
    rl.close();
  }
}

export async function keyCommand(opts: KeyOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const { logger } = opts;

  switch (opts.subcommand ?? 'list') {
    case 'list': {
      const profiles = await loadProfiles(home).catch(() => undefined);
      const keys = await listKeys({ home, ...(profiles ? { profiles } : {}) });

      if (logger.isJson) {
        logger.json({ keys });
        return 0;
      }
      if (keys.length === 0) {
        logger.warn(t('key.noKeys'));
        logger.dim(`create one with: gs key gen <name> --comment "<email>"`);
        return 0;
      }

      const width = Math.max(12, ...keys.map((k) => k.name.length));
      for (const key of keys) {
        const usedBy = key.usedBy.length > 0 ? key.usedBy.join(', ') : '(unused)';
        logger.ok(`${key.name.padEnd(width)}  ${(key.fingerprint ?? '?').padEnd(24)}  ${usedBy}`);
        if (key.comment) logger.dim(`   ${key.comment}`);
      }
      return 0;
    }

    case 'gen': {
      if (!opts.target) {
        logger.error('usage: gs key gen <name> [--comment "<email>"]');
        return 2;
      }
      const name = opts.target;
      const comment = process.env.GS_KEY_COMMENT ?? undefined;
      try {
        const result = await generateKey({ home, name, ...(comment ? { comment } : {}) });
        if (logger.isJson) {
          logger.json({ path: result.path, fingerprint: result.fingerprint ?? null });
          return 0;
        }
        logger.ok(t('key.created', `~/.ssh/${name}`));
        if (result.fingerprint) logger.dim(`   ${result.fingerprint}`);
        const copied = await copyToClipboard(result.publicKey);
        logger.info(copied ? t('key.copied') : t('key.copyManual'));
        if (!copied) logger.write(`${result.publicKey}\n`);
        return 0;
      } catch (err) {
        logger.error((err as Error).message);
        return 2;
      }
    }

    case 'copy': {
      if (!opts.target) {
        logger.error('usage: gs key copy <name>');
        return 2;
      }
      try {
        const pub = await publicKeyFor(home, opts.target);
        const copied = await copyToClipboard(pub);
        if (logger.isJson) {
          logger.json({ key: opts.target, copied });
          return 0;
        }
        if (copied) logger.ok(t('key.copiedNamed', opts.target));
        else {
          logger.warn(t('key.copyFailed'));
          logger.write(`${pub}\n`);
        }
        return 0;
      } catch (err) {
        logger.error((err as Error).message);
        return 2;
      }
    }

    case 'restore': {
      if (!opts.target) {
        logger.error('usage: gs key restore <snapshot> [--force]');
        return 2;
      }
      const text = await readSnapshotFile(opts.target);
      if (text === undefined) {
        logger.error(`cannot read ${opts.target}`);
        return 2;
      }

      const looksEncrypted = text.trimStart().startsWith('{') && text.includes('"magic"');
      let snapshot;
      try {
        if (looksEncrypted) {
          const passphrase = opts.passphrase ?? process.env.GS_PASSPHRASE ?? (await askPassphrase('passphrase'));
          snapshot = await decryptSnapshot(text, passphrase);
        } else {
          snapshot = JSON.parse(text);
        }
      } catch (err) {
        logger.error((err as Error).message);
        return 2;
      }

      const keys = keysFromSnapshot(snapshot as { files: { path: string; content: string }[] });
      if (keys.length === 0) {
        logger.warn(t('key.noKeysInSnapshot'));
        return 1;
      }

      const result = await restoreKeys({ home, keys, ...(opts.force ? { force: true } : {}) });
      if (logger.isJson) {
        logger.json(result);
        return 0;
      }
      for (const name of result.written) logger.ok(t('key.restored', `~/.ssh/${name}`));
      for (const name of result.skipped) {
        logger.warn(t('key.restoreSkipped', `~/.ssh/${name}`));
      }
      if (result.written.some((n) => !n.endsWith('.pub'))) {
        logger.dim(t('key.restoredMode'));
      }
      return 0;
    }

    default:
      logger.error(t('key.unknown', String(opts.subcommand)));
      logger.dim(t('key.available'));
      return 2;
  }
}
