#!/usr/bin/env node
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { listCommand } from './commands/list.ts';
import { diffCommand } from './commands/diff.ts';
import { applyCommand } from './commands/apply.ts';
import { initCommand } from './commands/init.ts';
import { doctorCommand } from './commands/doctor.ts';
import { guiCommand } from './commands/gui.ts';
import { keyCommand } from './commands/key.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { createLogger } from './util/log.ts';
import { resolveLanguage, setLanguage, t } from './core/i18n.ts';
import { ModelError } from './core/model.ts';
import { ProfilesMissingError } from './core/profiles.ts';
import { BlockError } from './core/managed-block.ts';

const VERSION = '0.1.0';

/** The help screen is built per language so `--lang` can change it. */
function usageText(): string {
  return `${t('usage.title')}

${t('usage.heading')}

${t('usage.commands')}
  init [--root <dir>]   ${t('init.usage')}
        [--force]       ${t('init.force')}
        [--offline]     ${t('init.offline')}
  list                  ${t('list_rules_hint')}
  diff                  ${t('diff_hint')}
  apply [--dry-run]     ${t('apply_hint')}
        [--force]       ${t('apply_force_hint')}
  doctor [--online]     ${t('doctor_hint')}
  gui [--port N]        ${t('gui_hint')}
        [--no-open]     ${t('gui_noopen_hint')}
        [--idle-timeout <min>]  ${t('gui_idle_hint')}
  key list              ${t('key_list_hint')}
  key gen <name>        ${t('key_gen_hint')}
  key copy <name>       ${t('key_copy_hint')}
  key restore <snapshot> [--force]
                        ${t('key_restore_hint')}
  snapshot export <file> [--with-keys] [--force]
                        ${t('snapshot_export_hint')}
  snapshot import <file> [--remap OLD=NEW] [--force]
                        ${t('snapshot_import_hint')}
  help                  ${t('usage.help')}
  version               ${t('usage.version')}

${t('usage.options')}
  --home <dir>          ${t('option_home')}
  --lang <en|zh-CN>     ${t('usage.lang')}
  --json                ${t('option_json')}
  --no-color            ${t('option_nocolor')}

${t('usage.exitCodes')}`;
}

interface ParsedArgs {
  command: string | undefined;
  /** positional arguments after the command: `key gen NAME` -> ['gen', 'NAME'] */
  args: string[];
  flags: Set<string>;
  /** multi-value: `--remap a=b --remap c=d` keeps both */
  values: Map<string, string[]>;
}

/** Last value wins; use this for single-valued flags. */
function valueOf(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** Every occurrence, in order: required for flags like `--remap`. */
function allOf(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

const VALUE_FLAGS = ['--home', '--port', '--idle-timeout', '--root', '--comment', '--remap', '--lang'];

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const record = (name: string, value: string) => {
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        record(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (VALUE_FLAGS.includes(arg)) {
        const next = argv[++i];
        if (next === undefined) throw new Error(`missing value for ${arg}`);
        record(arg.slice(2), next);
      } else {
        flags.add(arg.slice(2));
      }
      continue;
    }
    positionals.push(arg);
  }

  const [command, ...rest] = positionals;
  return { command, args: rest, flags, values };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const home = valueOf(args, 'home') ?? homedir();
  // language precedence: --lang, then GS_LANG, then the OS locale
  setLanguage(resolveLanguage(valueOf(args, 'lang')));

  // Report-style commands print an ordered narrative. Splitting errors and
  // warnings onto stderr would interleave with the stdout sections, so those
  // commands keep everything on one stream. `version`/`help` stay quiet.
  const REPORT_COMMANDS = new Set(['init', 'list', 'diff', 'apply', 'doctor', 'key', 'snapshot']);
  const logger = createLogger({
    json: args.flags.has('json'),
    color: !args.flags.has('no-color'),
    unifiedErrors: args.command !== undefined && REPORT_COMMANDS.has(args.command),
  });

  switch (args.command) {
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(usageText() + '\n');
      return 0;
    case 'version':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'init':
      return initCommand({
        home,
        ...(valueOf(args, 'root') !== undefined ? { roots: [valueOf(args, 'root') as string] } : {}),
        force: args.flags.has('force'),
        offline: args.flags.has('offline'),
        json: args.flags.has('json'),
        logger,
      });
    case 'list':
      return listCommand({ home, json: args.flags.has('json'), logger });
    case 'diff':
      return diffCommand({ home, json: args.flags.has('json'), logger });
    case 'apply':
      return applyCommand({
        home,
        json: args.flags.has('json'),
        dryRun: args.flags.has('dry-run'),
        force: args.flags.has('force'),
        logger,
      });
    case 'doctor':
      return doctorCommand({
        home,
        json: args.flags.has('json'),
        online: args.flags.has('online'),
        logger,
      });
    case 'gui': {
      const portValue = valueOf(args, 'port');
      const idleValue = valueOf(args, 'idle-timeout');
      return guiCommand({
        home,
        ...(portValue !== undefined ? { port: Number.parseInt(portValue, 10) } : {}),
        open: !args.flags.has('no-open'),
        ...(idleValue !== undefined ? { idleTimeoutMinutes: Number.parseInt(idleValue, 10) } : {}),
        json: args.flags.has('json'),
        logger,
      });
    }
    case 'key':
      return keyCommand({
        home,
        subcommand: args.args[0],
        target: args.args[1],
        force: args.flags.has('force'),
        json: args.flags.has('json'),
        logger,
      });
    case 'snapshot':
      return snapshotCommand({
        home,
        subcommand: args.args[0],
        target: args.args[1],
        remaps: allOf(args, 'remap'),
        withKeys: args.flags.has('with-keys'),
        force: args.flags.has('force'),
        json: args.flags.has('json'),
        logger,
      });
    default:
      logger.error(t('error.unknownCommand', String(args.command)));
      process.stdout.write(usageText() + '\n');
      return 2;
  }
}

const entry = process.argv[1];
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (err instanceof ProfilesMissingError) {
        process.stderr.write(`✗ ${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      if (err instanceof ModelError || err instanceof BlockError) {
        process.stderr.write(`✗ ${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`✗ ${message}\n`);
      process.exitCode = 2;
    });
}
