import { homedir } from 'node:os';
import { loadProfiles } from '../core/profiles.ts';
import { generateKey, listKeys, publicKeyFor, copyToClipboard } from '../core/keys.ts';
import type { Logger } from '../util/log.ts';

export interface KeyOptions {
  home?: string;
  subcommand: string | undefined;
  target: string | undefined;
  json?: boolean;
  logger: Logger;
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
        logger.warn('no SSH keys found in ~/.ssh');
        logger.dim('create one with: gs key gen <name> --comment "<email>"');
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
        logger.ok(`created ~/.ssh/${name}`);
        if (result.fingerprint) logger.dim(`   ${result.fingerprint}`);
        const copied = await copyToClipboard(result.publicKey);
        logger.info(copied ? 'public key copied to the clipboard' : 'public key (copy it manually):');
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
        if (copied) logger.ok(`public key for ${opts.target} copied to the clipboard`);
        else {
          logger.warn('could not access the clipboard; here is the key:');
          logger.write(`${pub}\n`);
        }
        return 0;
      } catch (err) {
        logger.error((err as Error).message);
        return 2;
      }
    }

    default:
      logger.error(`unknown key subcommand: ${opts.subcommand}`);
      logger.dim('available: list, gen, copy');
      return 2;
  }
}
