/**
 * Localisation (English / Simplified Chinese).
 *
 * Language is resolved once per process:
 *   1. `--lang <code>` on the command line
 *   2. `GS_LANG` environment variable
 *   3. `settings.language` in profiles.yaml
 *   4. the OS locale (LANG / LC_ALL / system locale), falling back to English
 *
 * Messages are looked up by key with positional placeholders ({0}, {1}, …).
 * A missing translation falls back to English so a stale catalogue can never
 * break the CLI.
 */

import { execFileSync } from 'node:child_process';

export type Language = 'en' | 'zh-CN';

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'zh-CN'];

/** Environment variables that can carry the language. */
export const LANG_ENV = 'GS_LANG';

let current: Language = 'en';

export function setLanguage(lang: Language): void {
  current = lang;
}

export function getLanguage(): Language {
  return current;
}

/**
 * Normalise a user-supplied language tag.
 * Accepts `zh`, `zh-cn`, `zh_CN`, `ZH`, `en`, `en-US`, …
 *
 * Returns `'en'` for a tag we recognise as a real language but do not translate:
 * a user who asks for Japanese should get English, never the OS language by
 * accident. Returns `undefined` only when the tag is empty or unparseable, which
 * means "no opinion — fall through to the next source".
 */
export function parseLanguage(input: string | undefined): Language | undefined {
  if (!input) return undefined;
  const tag = input.trim().toLowerCase().replace('_', '-');
  if (tag === '') return undefined;

  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  // Simplified Chinese only: zh-TW / zh-HK would otherwise show simplified text
  if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-hans' || tag === 'zh-sg' || tag === 'zh-my') {
    return 'zh-CN';
  }
  // Traditional Chinese and every other language have no catalogue yet
  if (/^[a-z]{2}(-[a-z0-9]+)*$/.test(tag)) return 'en';
  return undefined;
}

/**
 * The language Windows actually displays its UI in.
 *
 * `Intl.DateTimeFormat().resolvedOptions().locale` follows the *regional format*
 * setting, which is not the same thing: a Chinese machine set to English display
 * language (or the reverse) is common. On Windows, `wmic`/PowerShell exposes the
 * real UI culture, so ask it and fall back to Intl when that is unavailable.
 */
function windowsUiLanguage(): Language | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    // synchronous on purpose: language must be resolved before the first message
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-UICulture).Name'], {
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseLanguage(out.toString().trim());
  } catch {
    return undefined;
  }
}

/** Detect the operating system language without spawning a process on POSIX. */
export function detectSystemLanguage(): Language {
  const env = process.env;
  const fromEnv =
    parseLanguage(env.LC_ALL) ??
    parseLanguage(env.LC_MESSAGES) ??
    parseLanguage(env.LANG) ??
    undefined;
  if (fromEnv) return fromEnv;

  const fromWindows = windowsUiLanguage();
  if (fromWindows) return fromWindows;

  try {
    // `Intl` reflects the OS locale on every supported platform
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const parsed = parseLanguage(locale);
    if (parsed) return parsed;
  } catch {
    // ignore: fall through to the default
  }
  return 'en';
}

/**
 * Environment `Intl` reports on Windows reflects the user's regional settings,
 * which is what a Chinese Windows user expects.
 */
export function resolveLanguage(explicit?: string): Language {
  return (
    parseLanguage(explicit) ??
    parseLanguage(process.env[LANG_ENV]) ??
    detectSystemLanguage()
  );
}

/* ------------------------------------------------------------------ */
/* catalogues                                                          */
/* ------------------------------------------------------------------ */

type Catalogue = Record<string, string>;

const en: Catalogue = {
  // usage
  'usage.title': 'gs — Git & SSH identity manager',
  'usage.heading': 'Usage: gs <command> [options]',
  'usage.commands': 'Commands:',
  'usage.options': 'Options:',
  'usage.exitCodes': 'Exit codes: 0 ok · 1 warning · 2 error',
  'usage.help': 'Show this message',
  'usage.version': 'Print the version',
  'usage.lang': 'Output language: en | zh-CN (default: from GS_LANG or the OS)',
  'option_home': 'Use an alternative home directory',
  'option_json': 'Machine-readable output',
  'option_nocolor': 'Disable colours',
  'list_rules_hint': 'Show identities, directory rules and what applies here',
  'diff_hint': 'Preview every change gs would make',
  'apply_hint': 'Write managed blocks to ~/.gitconfig and ~/.ssh/config',
  'apply_force_hint': 'Overwrite managed blocks edited by hand',
  'doctor_hint': 'Diagnose keys, ssh config and the identity in this directory',
  'gui_hint': 'Open the local web UI (bound to 127.0.0.1)',
  'gui_noopen_hint': 'Do not launch a browser',
  'gui_idle_hint': 'Exit after N idle minutes (default 30, 0 disables)',
  'key_list_hint': 'List SSH keys with fingerprints and the identities using them',
  'key_gen_hint': 'Create a new ed25519 key pair (public key goes to the clipboard)',
  'key_copy_hint': 'Copy a public key to the clipboard',
  'key_restore_hint': 'Write the keys embedded in a snapshot back into ~/.ssh',
  'snapshot_export_hint': 'Write a portable snapshot (encrypted when it holds keys)',
  'snapshot_import_hint': 'Restore a profile from a snapshot',

  // generic
  'generic.none': 'none',
  'generic.notSet': 'not set',
  'generic.unknown': 'unknown',
  'generic.yes': 'yes',
  'generic.no': 'no',

  // init
  'init.usage':
    'Detect SSH hosts, repositories and working keys; write a profile',
  'init.force': 'Overwrite an existing profile',
  'init.offline': 'Skip network probing of keyless sites',
  'init.detected': 'detected',
  'init.gitIdentity': 'git identity',
  'init.sshHosts': 'ssh hosts',
  'init.repositories': 'repositories',
  'init.proposedIdentities': 'proposed identities',
  'init.proposedRules': 'proposed rules',
  'init.noRules': 'no directory rules could be inferred; add them to profiles.yaml',
  'init.keysDiscovered': 'SSH keys discovered by probing',
  'init.noKeyAccepted':
    '{0}: no key in ~/.ssh was accepted; the key may be missing, or its permissions may be too open',
  'init.noKeyAcceptedHint': 'run `gs doctor --online` for the exact reason and a fix',
  'init.noKeyWorks':
    '{0}: no SSH key works yet; add sshKey to the identity in profiles.yaml (gs doctor --online shows the details)',
  'init.sharedEmail':
    'all {0} identities were given the global email {1}',
  'init.sharedEmailPersonal': 'likely personal: {0}',
  'init.sharedEmailHint':
    'edit ~/.config/gs/profiles.yaml and set user.email per identity, then re-run gs apply',
  'init.wrote': 'wrote {0}',
  'init.next': 'next: review identities/emails above, then: gs diff   then   gs apply',
  'init.noSshConfig': 'no {0}; SSH hosts could not be detected',
  'init.noGitIdentity': 'none (global user.name/email not set)',
  'init.noIdentity': 'could not determine any identity: set user.name and user.email in git first',

  // list
  'list.identities': 'identities',
  'list.rules': 'directory rules',
  'list.repositories': 'repository overrides',
  'list.currentDir': 'current directory',
  'list.noRule': '{0}  ->  no matching rule (falls back to the global identity)',
  'list.fallsBackTo': 'falls back to: {0}',
  'list.fallsBackToUnset': 'falls back to: nothing is set — commits will fail until user.name/user.email exist',
  'list.globalIdentity': 'global identity (used by every directory without a rule)',
  'list.globalUnset': 'not set (no user.name/user.email in ~/.gitconfig)',
  'list.profile': 'profile: {0}',

  // diff / apply
  'diff.noChanges': 'no changes (already up to date)',
  'diff.wouldChange': '{0} file(s) would change',
  'apply.backup': 'backup {0}',
  'apply.wrote': 'wrote {0}',
  'apply.noChanges': 'no changes (already up to date)',
  'apply.wouldKind': 'would {0}: {1}',

  // doctor
  'doctor.langNote': 'language: {0}',
  'doctor.profileLoaded': 'profile loaded',
  'doctor.profileMissing': 'no profile found',
  'doctor.keyPresent': '{0} present',
  'doctor.keyMissing': '{0} does not exist',
  'doctor.keyMissingDetail':
    'referenced by {0}; git push/pull will fail with "no such identity"',
  'doctor.keyNotPrivate': '{0} does not look like a private key',
  'doctor.keyTooOpen': '{0} permissions are too open ({1})',
  'doctor.keyPermOk': '{0} permissions {1}',
  'doctor.keyAclOk': '{0} ACL is restricted to its owner',
  'doctor.keyAclOther': '{0} is accessible to other principals',
  'doctor.identityHere': 'identity here: {0}',
  'doctor.identityElsewhere': 'identity here comes from {0}',
  'doctor.identityElsewhereDetail':
    'resolved email is {0}; no gs rule matched this repository',
  'doctor.repoLocalOverride': 'this repository overrides its identity locally ({0})',
  'doctor.repoLocalDetail':
    'repository-local user.email takes precedence over every directory rule',
  'doctor.repoLocalFix':
    'git config --local --unset user.email (and user.name) to inherit from the directory rule',
  'doctor.notARepo': '{0} is not a Git repository',
  'doctor.notARepoDetail': 'includeIf "gitdir:" only applies inside repositories',
  'doctor.sshNoBlock': '{0} has no gs managed block',
  'doctor.sshNoBlockDetail': 'generated host aliases are not in place',
  'doctor.sshNoConfig': 'no ~/.ssh/config yet',
  'doctor.sshNoConfigDetail': 'run `gs apply` to generate the managed host block',
  'doctor.sshBlockOk': '{0} managed block present',
  'doctor.sshShadow':
    'host aliases also defined outside the gs block: {0}',
  'doctor.sshShadowDetail':
    'OpenSSH uses the first match, so your own entries take precedence',
  'doctor.wildcardKey': 'a wildcard Host block pins IdentityFile ({0})',
  'doctor.wildcardDetail':
    'OpenSSH applies wildcard IdentityFile entries before host-specific ones, so the wrong key may be offered first and authentication can fail',
  'doctor.wildcardFix':
    'remove IdentityFile from the wildcard block, or set it explicitly per Host',
  'doctor.notProbed': 'connectivity not probed',
  'doctor.notProbedDetail': 'pass --online to run real ssh handshakes',
  'doctor.skippedProbe': '{0}: skipped connectivity probe',
  'doctor.skippedProbeDetail': 'no usable SSH key for this site',
  'doctor.authenticated': '{0}: authenticated',
  'doctor.authFailed': '{0}: authentication failed',
  'doctor.unresolved': '{0}: could not be resolved',
  'doctor.summary': '{0} ok · {1} warnings · {2} errors',

  // key
  'key.listTitle': 'SSH keys',
  'key.noKeys': 'no SSH keys found in ~/.ssh',
  'key.noKeysHint': 'create one with: gs key gen <name> --comment "<email>"',
  'key.created': 'created {0}',
  'key.copied': 'public key copied to the clipboard',
  'key.copyManual': 'public key (copy it manually):',
  'key.copiedNamed': 'public key for {0} copied to the clipboard',
  'key.copyFailed': 'could not access the clipboard; here is the key:',
  'key.restored': 'restored {0}',
  'key.restoreSkipped': '{0} already exists; pass --force to overwrite',
  'key.restoredMode': 'private keys were restored with mode 600',
  'key.noKeysInSnapshot': 'this snapshot contains no keys (export it with --with-keys)',
  'key.unknown': 'unknown key subcommand: {0}',
  'key.available': 'available: list, gen, copy, restore',

  // snapshot
  'snapshot.exported': 'wrote {0}',
  'snapshot.exportSummary': '{0} files · {1} identities · {2} rules',
  'snapshot.hasKeys': 'contains PRIVATE KEYS and is encrypted; keep the passphrase safe',
  'snapshot.noKeys': 'no private keys included (--with-keys adds them, encrypted)',
  'snapshot.imported': 'imported {0} identities and {1} rules',
  'snapshot.remapped': 'remapped {0} -> {1}',
  'snapshot.keysNotWritten':
    'the snapshot holds private keys, which this command does NOT write to ~/.ssh',
  'snapshot.keysRestoreHint': 'restore them explicitly with: gs key restore {0}',
  'snapshot.exists': '{0} already exists; pass --force to overwrite',
  'snapshot.cannotRead': 'cannot read {0}',
  'snapshot.profileExists':
    'a profile already exists at ~/.config/gs/profiles.yaml; pass --force to replace it',
  'snapshot.next': 'next: gs doctor   then   gs diff   then   gs apply',
  'snapshot.usage': 'usage: gs snapshot <export|import> <file>',

  // errors
  'error.unknownCommand': 'unknown command: {0}',

  // gui
  'gui.listening': 'GUI listening on {0}',
  'gui.tokenHint': 'the token is embedded in the URL fragment; open the printed link',
  'gui.opening': 'opening your browser…',
  'gui.home': 'operating on {0}',
  'gui.sandboxWarn':
    'NOTE: this is a SANDBOX home, not your real one. Changes made here do not affect ~/.ssh or ~/.gitconfig.',
  'gui.realHome': 'this is your real home; changes here affect your live configuration',
  'gui.alreadyRunning': 'gs gui is already running on port {0}',
  'gui.alreadyRunningHint': 'open {0} in your browser (restart that instance to get a fresh token)',
  'gui.idleExit': 'no activity for {0} minutes, shutting down',
  'gui.assetsMissing':
    'GUI assets not found. If you are running from a checkout, make sure the web/ directory is present; for a packaged install, reinstall git-switch.',
  'gui.noProfile': 'no profile found; run `gs init` first',

  // web UI
  'web.title': 'gs — Git & SSH identities',
  'web.tab.overview': 'Overview',
  'web.tab.identities': 'Identities',
  'web.tab.rules': 'Rules',
  'web.tab.preview': 'Preview',
  'web.tab.doctor': 'Diagnostics',
  'web.tab.keys': 'Keys',
  'web.tab.snapshot': 'Migrate',
  'web.tab.init': 'Setup',
  'web.language': 'Language',
  'web.loading': 'loading…',
  'web.counts': '{0} identities · {1} rules · {2} overrides',
  'web.noKey': 'no key',
  'web.noSites': 'no sites',
  'web.viewDiff': 'View diff',
  'web.nextStep': 'Next step',
  'web.globalIdentity': 'Global identity',
  'web.globalIdentityHint': 'Used by every directory that no rule matches, including new clones.',
  'web.globalUnset': 'not set (no user.name/user.email in ~/.gitconfig)',
  'web.nextStepBody': 'Check the pending changes before writing anything.',
  'web.nextStepHint': 'gs never writes without showing you the diff first.',
  'web.openPreview': 'Open preview',
  'web.noIdentities': 'No identities defined. Run gs init first.',
  'web.noRules': 'No rules yet — every repository falls back to the global identity.',
  'web.remove': 'Remove',
  'web.removeConfirm': 'Remove the rule for {0}?',
  'web.ruleRemoved': 'Rule removed — apply to make it effective',
  'web.addRuleTitle': 'Add a rule',
  'web.pathPlaceholder': '/path/to/directory',
  'web.browse': 'Browse',
  'web.addRule': 'Add rule',
  'web.enterDir': 'Enter a directory first',
  'web.ruleAdded': 'Rule added — open Preview to apply',
  'web.up': 'Up',
  'web.open': 'Open',
  'web.pendingTitle': 'Pending changes',
  'web.computing': 'computing the plan…',
  'web.fixErrorsFirst': 'Fix the errors above before applying.',
  'web.noChanges': 'No changes — the generated files already match your profile.',
  'web.backToOverview': 'Back to overview',
  'web.willChange': '{0} file(s) will change',
  'web.backupHint': 'Each file is backed up before it is written.',
  'web.apply': 'Apply changes',
  'web.applying': 'Applying…',
  'web.appliedWithErrors': 'Applied with {0} error(s)',
  'web.applied': 'Applied — {0} file(s) written',
  'web.binaryDiff': 'binary or empty diff',
  'web.runAgain': 'Run again',
  'web.runOnline': 'Run with SSH probes',
  'web.checking': 'checking…',
  'web.missingToken':
    'Missing token. Open the URL that `gs gui` printed, which includes #token=…',
  'web.sandboxBanner':
    'SANDBOX: operating on {0}. Changes here do NOT touch your real ~/.ssh or ~/.gitconfig.',
  'web.realHomeBanner': 'Operating on your real home: {0}',
  'web.profileError': 'The profile could not be loaded: {0}',
  'web.profileErrorHint':
    'Fix {0} and reload. The screens below show no data until the profile is valid.',
  'web.reload': 'Reload',
  'web.tryFix': 'Fix it for me',
  'web.confirmFix': 'Replace "{0}" with "{1}"? A backup of the profile is kept.',
  'web.cannotFix': 'This one needs a manual edit. Open the file below and correct the shown field.',
  'web.showFile': 'Show file path',
  'web.fixApplied': 'Profile repaired — reloading',
  'web.dismiss': 'Dismiss',
  'web.identitiesTitle': 'Identities',
  'web.addIdentity': 'Add identity',
  'web.addIdentityTitle': 'New identity',
  'web.identityName': 'Name',
  'web.identityNameHint': 'letters, digits, dot, dash, underscore',
  'web.userName': 'Commit name',
  'web.userEmail': 'Commit email',
  'web.sshKey': 'SSH key (file name in ~/.ssh)',
  'web.sshKeyNone': '(none)',
  'web.siteHost': 'Host',
  'web.sitePort': 'Port (optional)',
  'web.siteAlias': 'Alias (optional)',
  'web.identitySites': 'sites',
  'web.identityNoSites': 'no sites — SSH routing will not be generated',
  'web.save': 'Save',
  'web.cancel': 'Cancel',
  'web.deleteIdentity': 'Delete identity',
  'web.deleteIdentityConfirm': 'Delete identity "{0}"? Rules using it will also be removed.',
  'web.identityAdded': 'Identity "{0}" added — open Preview to apply',
  'web.identityDeleted': 'Identity "{0}" deleted — open Preview to apply',
  'web.identityInUse': 'identity "{0}" is still used by {1} rule(s)',
  'web.lastIdentity': 'the last identity cannot be deleted: a profile needs at least one',
  'web.duplicateIdentity': 'an identity named "{0}" already exists',
  'web.invalidIdentity': 'check the fields: {0}',
  'web.required': 'required',
  'web.invalidEmail': 'not a valid email',
  'web.invalidName': 'use letters, digits, dot, dash or underscore',
  'web.errorsTag': '{0} errors',
  'web.warningsTag': '{0} warnings',
  'web.okTag': '{0} ok',

  // keys screen
  'web.keysTitle': 'SSH keys',
  'web.keysEmpty': 'No SSH keys found in ~/.ssh',
  'web.keyFingerprint': 'Fingerprint',
  'web.keyUsedBy': 'Used by',
  'web.keyUnused': '(unused)',
  'web.keyNoPublic': 'no .pub file',
  'web.copyPublicKey': 'Copy public key',
  'web.publicKeyCopied': 'Public key copied to the clipboard',
  'web.publicKeyCopyFailed': 'Could not reach the clipboard; the key is shown below',
  'web.generateKey': 'Generate key',
  'web.generateKeyTitle': 'New SSH key',
  'web.keyType': 'Type',
  'web.keyComment': 'Comment',
  'web.generateKeyConfirm': 'Create a new key pair in ~/.ssh named "{0}"?',
  'web.keyGenerated': 'Key "{0}" created',
  'web.restoreTitle': 'Restore keys from a snapshot',
  'web.restoreKeys': 'Restore keys',
  'web.restoreConfirm': 'Write the keys from this snapshot into ~/.ssh? Existing files are kept.',
  'web.keysRestored': '{0} key file(s) restored',
  'web.keysSkipped': '{0} existing file(s) kept',
  'web.renameKey': 'Rename',
  'web.renameKeyTitle': 'Rename key',
  'web.newKeyName': 'New name',
  'web.renameConfirm': 'Rename "{0}" to "{1}"? Identities using it will be updated.',
  'web.keyRenamed': 'Renamed "{0}" to "{1}"',
  'web.keyRenamedIdentities': '{0} identity reference(s) updated',
  'web.globalIdentityTitle': 'Global identity',
  'web.globalIdentityFormHint':
    'Applies to every directory no rule matches. Stored in ~/.gitconfig, outside the gs managed block.',
  'web.globalIdentitySaved': 'Global identity set to {0}',
  'web.globalIdentityWas': 'Previous value: {0}',

  // snapshot screen
  'web.snapshotTitle': 'Migrate',
  'web.exportTitle': 'Export a snapshot',
  'web.exportPath': 'Destination',
  'web.exportPathHint': 'leave empty for ~/.config/gs/snapshots/',
  'web.withKeys': 'Include private keys (encrypted)',
  'web.passphrase': 'Passphrase',
  'web.passphraseHint': 'at least 8 characters; required when keys are included',
  'web.exportSnapshot': 'Export',
  'web.exported': 'Snapshot written to {0}',
  'web.exportSummary': '{0} files · {1} identities · {2} rules',
  'web.importTitle': 'Import a snapshot',
  'web.importPath': 'Snapshot file',
  'web.remap': 'Path remapping (old=new, comma separated)',
  'web.remapHint': 'optional, e.g. D:/CODE=/home/me/code',
  'web.importSnapshot': 'Import',
  'web.importConfirm': 'Replace ~/.config/gs/profiles.yaml with the imported profile?',
  'web.imported': 'Imported {0} identities and {1} rules — open Preview to apply',
  'web.importHasKeys': 'the snapshot contains encrypted private keys; use “Restore keys” below',
  'web.editIdentity': 'Edit',
  'web.saveEdit': 'Save changes',
  'web.unknownIdentity': 'identity "{0}" no longer exists',
  'web.identityUpdated': 'Identity "{0}" updated — open Preview to apply',
  'web.editHint': 'Editing a name also updates every rule and site that refers to it.',

  // field labels (used by every form)
  'web.field.name': 'Name',
  'web.field.userName': 'Commit name',
  'web.field.email': 'Commit email',
  'web.field.sshKey': 'SSH key',
  'web.field.siteHost': 'Host',
  'web.field.sitePort': 'Port',
  'web.field.siteAlias': 'Alias',
  'web.field.dir': 'Directory',
  'web.field.identity': 'Identity',
  'web.field.keyName': 'Key name',
  'web.field.keyType': 'Key type',
  'web.field.keyComment': 'Comment',
  'web.field.snapshot': 'Snapshot file',
  'web.field.passphrase': 'Passphrase',
  'web.field.remaps': 'Path remapping',
  'web.field.root': 'Scan root',
  'web.field.keyFile': 'Key file',
  'web.optional': 'optional',
  'web.section.identity': 'Basic identity',
  'web.section.key': 'SSH key',
  'web.section.site': 'Site',
  'web.section.target': 'Target directory',
  'web.section.assign': 'Assign to an identity',
  'web.section.lookup': 'Choose a directory',
  'web.section.import': 'Import from a snapshot',
  'web.selectPlaceholder': '— select —',
  'web.noneOption': '(none)',
  'web.keyfileHint': 'file name under ~/.ssh, e.g. id_ed25519_work',
  'web.keyfileNone': 'No key (SSH routing is skipped for this identity)',
  'web.hostHint': 'e.g. github.com',
  'web.portHint': 'leave empty for the default (22)',
  'web.aliasHint': 'short name used in SSH config, e.g. gh',
  'web.dirHint': 'absolute path, e.g. D:/CODE/github',
  'web.identityOrderHint': 'Rules are matched by longest directory first.',
  'web.ruleCount': '{0} rule(s)',
  'web.keyMissing': '(not found on disk)',
  'web.useThisDir': 'Use this directory',
  'web.noKeysYet': 'No SSH keys exist yet. Create one first — an identity needs a key to route SSH.',
  'web.goToKeys': 'Go to Keys',
  'web.keyRequired': 'Create a key on the Keys screen first, then come back here.',
  'web.keyNextStep': 'Key created. Add it to the forge, then use it in an identity.',
  'web.goToIdentities': 'Go to Identities',

  // init screen
  'web.initTitle': 'Setup',
  'web.initAlreadyExists': 'A profile already exists. Setup only runs on a fresh machine; edit the profile on the Identities tab instead.',
  'web.initDetected': 'Detected',
  'web.initScanning': 'scanning…',
  'web.initStart': 'Scan D:/… and write a profile',
  'web.initStartHint': 'the scan reads your SSH config and Git repositories; nothing is written until you save',
  'web.initSaved': 'Profile written — open Preview to apply',
  'web.initOffline': 'Skip SSH probing (offline)',
  'web.initExistsConfirm': 'A profile already exists at ~/.config/gs/profiles.yaml. Overwrite it?',
};

const zhCN: Catalogue = {
  'usage.title': 'gs — Git 与 SSH 身份管理器',
  'usage.heading': '用法：gs <命令> [选项]',
  'usage.commands': '命令：',
  'usage.options': '选项：',
  'usage.exitCodes': '退出码：0 成功 · 1 警告 · 2 错误',
  'usage.help': '显示本帮助',
  'usage.version': '显示版本号',
  'usage.lang': '输出语言：en | zh-CN（默认取自 GS_LANG 或系统语言）',
  'option_home': '使用备用的 home 目录',
  'option_json': '输出机器可读的 JSON',
  'option_nocolor': '禁用彩色输出',
  'list_rules_hint': '查看身份、目录规则以及当前目录的归属',
  'diff_hint': '预览 gs 将做出的全部变更',
  'apply_hint': '把托管块写入 ~/.gitconfig 与 ~/.ssh/config',
  'apply_force_hint': '覆盖被手工修改过的托管块',
  'doctor_hint': '诊断密钥、SSH 配置以及当前目录对应的身份',
  'gui_hint': '打开本地图形界面（仅监听 127.0.0.1）',
  'gui_noopen_hint': '不要自动打开浏览器',
  'gui_idle_hint': '闲置 N 分钟后退出（默认 30，0 表示不退出）',
  'key_list_hint': '列出 SSH 密钥的指纹及使用它的身份',
  'key_gen_hint': '创建新的 ed25519 密钥对（公钥会复制到剪贴板）',
  'key_copy_hint': '复制公钥到剪贴板',
  'key_restore_hint': '把快照中的密钥恢复到 ~/.ssh',
  'snapshot_export_hint': '导出可移植快照（含密钥时自动加密）',
  'snapshot_import_hint': '从快照恢复配置',

  'generic.none': '无',
  'generic.notSet': '未设置',
  'generic.unknown': '未知',
  'generic.yes': '是',
  'generic.no': '否',

  'init.usage': '探测 SSH 主机、仓库与可用密钥，生成初始配置',
  'init.force': '覆盖已存在的配置',
  'init.offline': '跳过对无密钥站点的网络探测',
  'init.detected': '探测结果',
  'init.gitIdentity': 'git 身份',
  'init.sshHosts': 'SSH 主机',
  'init.repositories': '仓库',
  'init.proposedIdentities': '建议的身份',
  'init.proposedRules': '建议的目录规则',
  'init.noRules': '未能推断出目录规则，请在 profiles.yaml 中手动添加',
  'init.keysDiscovered': '通过探测发现可用密钥',
  'init.noKeyAccepted':
    '{0}：~/.ssh 中没有可用密钥通过认证；可能缺少密钥，或密钥权限过宽',
  'init.noKeyAcceptedHint': '运行 `gs doctor --online` 查看具体原因与修复方法',
  'init.noKeyWorks':
    '{0}：暂时没有可用的 SSH 密钥，请在 profiles.yaml 中为该身份设置 sshKey（`gs doctor --online` 可查看详情）',
  'init.sharedEmail': '{0} 个身份都使用了全局邮箱 {1}',
  'init.sharedEmailPersonal': '疑似个人身份：{0}',
  'init.sharedEmailHint':
    '编辑 ~/.config/gs/profiles.yaml，为各身份设置 user.email，然后重新运行 gs apply',
  'init.wrote': '已写入 {0}',
  'init.next': '下一步：核对上面的身份与邮箱，然后运行 gs diff，再运行 gs apply',
  'init.noSshConfig': '未找到 {0}，无法探测 SSH 主机',
  'init.noGitIdentity': '未设置（全局 user.name/email 为空）',
  'init.noIdentity': '无法确定任何身份：请先在 git 中设置 user.name 和 user.email',

  'list.identities': '身份',
  'list.rules': '目录规则',
  'list.repositories': '仓库级覆盖',
  'list.currentDir': '当前目录',
  'list.noRule': '{0}  ->  没有匹配的规则（将回退到全局身份）',
  'list.fallsBackTo': '回退到：{0}',
  'list.fallsBackToUnset': '回退到：未设置 —— 在配置 user.name/user.email 之前提交会失败',
  'list.globalIdentity': '全局身份（所有没有规则的目录都会使用它）',
  'list.globalUnset': '未设置（~/.gitconfig 中没有 user.name/user.email）',
  'list.profile': '配置文件：{0}',

  'diff.noChanges': '没有变更（已是最新）',
  'diff.wouldChange': '{0} 个文件将被修改',
  'apply.backup': '备份 {0}',
  'apply.wrote': '已写入 {0}',
  'apply.noChanges': '没有变更（已是最新）',
  'apply.wouldKind': '将{0}：{1}',

  'doctor.langNote': '语言：{0}',
  'doctor.profileLoaded': '配置已加载',
  'doctor.profileMissing': '未找到配置文件',
  'doctor.keyPresent': '{0} 存在',
  'doctor.keyMissing': '{0} 不存在',
  'doctor.keyMissingDetail': '被 {0} 引用；git push/pull 会报 "no such identity"',
  'doctor.keyNotPrivate': '{0} 看起来不是私钥文件',
  'doctor.keyTooOpen': '{0} 权限过宽（{1}）',
  'doctor.keyPermOk': '{0} 权限 {1}',
  'doctor.keyAclOk': '{0} 的 ACL 仅限所有者访问',
  'doctor.keyAclOther': '{0} 可被其他主体访问',
  'doctor.identityHere': '当前身份：{0}',
  'doctor.identityElsewhere': '当前身份来自 {0}',
  'doctor.identityElsewhereDetail': '解析出的邮箱是 {0}；没有 gs 规则匹配这个仓库',
  'doctor.repoLocalOverride': '该仓库在本地覆盖了身份（{0}）',
  'doctor.repoLocalDetail': '仓库级的 user.email 会优先于所有目录规则',
  'doctor.repoLocalFix':
    '执行 git config --local --unset user.email（以及 user.name）以继承目录规则',
  'doctor.notARepo': '{0} 不是 Git 仓库',
  'doctor.notARepoDetail': 'includeIf "gitdir:" 只在仓库内生效',
  'doctor.sshNoBlock': '{0} 中没有 gs 托管块',
  'doctor.sshNoBlockDetail': '生成的主机别名尚未写入',
  'doctor.sshNoConfig': '还没有 ~/.ssh/config',
  'doctor.sshNoConfigDetail': '运行 `gs apply` 生成托管主机块',
  'doctor.sshBlockOk': '{0} 中存在托管块',
  'doctor.sshShadow': '以下主机别名在 gs 块之外也有定义：{0}',
  'doctor.sshShadowDetail': 'OpenSSH 取第一个匹配项，因此你自己的配置会优先生效',
  'doctor.wildcardKey': '通配 Host 块中指定了 IdentityFile（{0}）',
  'doctor.wildcardDetail':
    'OpenSSH 会先应用通配块中的 IdentityFile，可能导致先尝试错误的密钥而认证失败',
  'doctor.wildcardFix': '从通配块中移除 IdentityFile，或为每个 Host 显式指定',
  'doctor.notProbed': '未进行连通性探测',
  'doctor.notProbedDetail': '加上 --online 可执行真实的 ssh 握手',
  'doctor.skippedProbe': '{0}：跳过连通性探测',
  'doctor.skippedProbeDetail': '该站点没有可用的 SSH 密钥',
  'doctor.authenticated': '{0}：认证成功',
  'doctor.authFailed': '{0}：认证失败',
  'doctor.unresolved': '{0}：无法解析主机名',
  'doctor.summary': '{0} 项正常 · {1} 项警告 · {2} 项错误',

  'key.listTitle': 'SSH 密钥',
  'key.noKeys': '~/.ssh 中没有找到 SSH 密钥',
  'key.noKeysHint': '创建方式：gs key gen <名称> --comment "<邮箱>"',
  'key.created': '已创建 {0}',
  'key.copied': '公钥已复制到剪贴板',
  'key.copyManual': '公钥（请手动复制）：',
  'key.copiedNamed': '{0} 的公钥已复制到剪贴板',
  'key.copyFailed': '无法访问剪贴板，公钥如下：',
  'key.restored': '已恢复 {0}',
  'key.restoreSkipped': '{0} 已存在；加 --force 可覆盖',
  'key.restoredMode': '私钥已按 600 权限恢复',
  'key.noKeysInSnapshot': '该快照中没有密钥（导出时请加 --with-keys）',
  'key.unknown': '未知的 key 子命令：{0}',
  'key.available': '可用：list、gen、copy、restore',

  'snapshot.exported': '已写入 {0}',
  'snapshot.exportSummary': '{0} 个文件 · {1} 个身份 · {2} 条规则',
  'snapshot.hasKeys': '包含私钥并已加密，请妥善保管口令',
  'snapshot.noKeys': '未包含私钥（加 --with-keys 可包含，且会加密）',
  'snapshot.imported': '已导入 {0} 个身份和 {1} 条规则',
  'snapshot.remapped': '已改写 {0} -> {1}',
  'snapshot.keysNotWritten': '快照中包含私钥，但本命令不会写入 ~/.ssh',
  'snapshot.keysRestoreHint': '如需恢复，请显式执行：gs key restore {0}',
  'snapshot.exists': '{0} 已存在；加 --force 可覆盖',
  'snapshot.cannotRead': '无法读取 {0}',
  'snapshot.profileExists': '~/.config/gs/profiles.yaml 已存在；加 --force 可替换',
  'snapshot.next': '下一步：gs doctor → gs diff → gs apply',
  'snapshot.usage': '用法：gs snapshot <export|import> <文件>',

  'error.unknownCommand': '未知命令：{0}',

  'gui.listening': '图形界面已启动：{0}',
  'gui.tokenHint': '访问口令在 URL 的 # 片段中，请打开打印出来的链接',
  'gui.opening': '正在打开浏览器…',
  'gui.home': '当前操作的目录：{0}',
  'gui.sandboxWarn':
    '注意：这是沙箱目录，不是你真实的 home。此处的改动不会影响 ~/.ssh 或 ~/.gitconfig。',
  'gui.realHome': '这是你的真实 home，此处的改动会直接生效',
  'gui.alreadyRunning': 'gs gui 已在端口 {0} 上运行',
  'gui.alreadyRunningHint': '请在浏览器打开 {0}（重启该实例可获取新口令）',
  'gui.idleExit': '已闲置 {0} 分钟，正在退出',
  'gui.assetsMissing':
    '未找到界面资源。若从源码运行，请确认 web/ 目录存在；若是安装包，请重新安装 git-switch。',
  'gui.noProfile': '未找到配置，请先运行 `gs init`',

  'web.title': 'gs — Git 与 SSH 身份管理',
  'web.tab.overview': '总览',
  'web.tab.identities': '身份',
  'web.tab.rules': '规则',
  'web.tab.preview': '变更预览',
  'web.tab.doctor': '诊断',
  'web.tab.keys': '密钥',
  'web.tab.snapshot': '迁移',
  'web.tab.init': '初始化',
  'web.language': '语言',
  'web.loading': '加载中…',
  'web.counts': '{0} 个身份 · {1} 条规则 · {2} 个覆盖',
  'web.noKey': '无密钥',
  'web.noSites': '无站点',
  'web.viewDiff': '查看变更',
  'web.nextStep': '下一步',
  'web.globalIdentity': '全局身份',
  'web.globalIdentityHint': '所有没有匹配规则的目录都会使用它，包括新克隆的仓库。',
  'web.globalUnset': '未设置（~/.gitconfig 中没有 user.name/user.email）',
  'web.nextStepBody': '写入任何内容之前，请先确认待应用的变更。',
  'web.nextStepHint': 'gs 总是先展示差异，再写入文件。',
  'web.openPreview': '打开预览',
  'web.noIdentities': '尚未定义身份，请先运行 gs init。',
  'web.noRules': '还没有规则——所有仓库都会回退到全局身份。',
  'web.remove': '删除',
  'web.removeConfirm': '确定删除 {0} 的规则？',
  'web.ruleRemoved': '规则已删除——应用后生效',
  'web.addRuleTitle': '添加规则',
  'web.pathPlaceholder': '/目录/路径',
  'web.browse': '浏览',
  'web.addRule': '添加规则',
  'web.enterDir': '请先输入目录',
  'web.ruleAdded': '规则已添加——打开预览以应用',
  'web.up': '上一级',
  'web.open': '打开',
  'web.pendingTitle': '待应用的变更',
  'web.computing': '正在计算变更…',
  'web.fixErrorsFirst': '请先修复上面的错误再应用。',
  'web.noChanges': '没有变更——生成的文件已与配置一致。',
  'web.backToOverview': '返回总览',
  'web.willChange': '{0} 个文件将被修改',
  'web.backupHint': '每个文件在写入前都会备份。',
  'web.apply': '应用变更',
  'web.applying': '正在应用…',
  'web.appliedWithErrors': '已应用，但有 {0} 个错误',
  'web.applied': '已应用——写入 {0} 个文件',
  'web.binaryDiff': '二进制内容或空差异',
  'web.runAgain': '重新检查',
  'web.runOnline': '执行 SSH 探测',
  'web.checking': '检查中…',
  'web.missingToken': '缺少访问口令。请打开 `gs gui` 打印的、包含 #token=… 的地址。',
  'web.sandboxBanner':
    '沙箱：当前操作的是 {0}。此处的改动不会影响你真实的 ~/.ssh 和 ~/.gitconfig。',
  'web.realHomeBanner': '正在操作你的真实 home：{0}',
  'web.profileError': '配置文件加载失败：{0}',
  'web.profileErrorHint': '请修正 {0} 后刷新页面。在配置合法之前，下方页面不会显示数据。',
  'web.reload': '刷新',
  'web.tryFix': '帮我修复',
  'web.confirmFix': '把「{0}」替换为「{1}」？会保留配置文件的备份。',
  'web.cannotFix': '这一项需要手动修改。请打开下方文件，修正提示的字段。',
  'web.showFile': '显示文件路径',
  'web.fixApplied': '配置已修复——正在刷新',
  'web.dismiss': '知道了',
  'web.identitiesTitle': '身份',
  'web.addIdentity': '新增身份',
  'web.addIdentityTitle': '新建身份',
  'web.identityName': '名称',
  'web.identityNameHint': '可使用字母、数字、点、横线和下划线',
  'web.userName': '提交者名称',
  'web.userEmail': '提交邮箱',
  'web.sshKey': 'SSH 密钥（~/.ssh 中的文件名）',
  'web.sshKeyNone': '（无）',
  'web.siteHost': '主机',
  'web.sitePort': '端口（可选）',
  'web.siteAlias': '别名（可选）',
  'web.identitySites': '站点',
  'web.identityNoSites': '没有站点——不会生成 SSH 路由',
  'web.save': '保存',
  'web.cancel': '取消',
  'web.deleteIdentity': '删除身份',
  'web.deleteIdentityConfirm': '确定删除身份「{0}」？使用它的规则也会被一并删除。',
  'web.identityAdded': '已新增身份「{0}」——打开预览以应用',
  'web.identityDeleted': '已删除身份「{0}」——打开预览以应用',
  'web.identityInUse': '身份「{0}」仍被 {1} 条规则使用',
  'web.lastIdentity': '不能删除最后一个身份：配置中至少要有一个身份',
  'web.duplicateIdentity': '已存在名为「{0}」的身份',
  'web.invalidIdentity': '请检查字段：{0}',
  'web.required': '必填',
  'web.invalidEmail': '邮箱格式不正确',
  'web.invalidName': '请使用字母、数字、点、横线或下划线',
  'web.errorsTag': '{0} 个错误',
  'web.warningsTag': '{0} 个警告',
  'web.okTag': '{0} 项正常',

  // keys screen
  'web.keysTitle': 'SSH 密钥',
  'web.keysEmpty': '~/.ssh 中没有找到 SSH 密钥',
  'web.keyFingerprint': '指纹',
  'web.keyUsedBy': '使用身份',
  'web.keyUnused': '（未使用）',
  'web.keyNoPublic': '没有 .pub 公钥文件',
  'web.copyPublicKey': '复制公钥',
  'web.publicKeyCopied': '公钥已复制到剪贴板',
  'web.publicKeyCopyFailed': '无法访问剪贴板，公钥如下',
  'web.generateKey': '生成密钥',
  'web.generateKeyTitle': '新建 SSH 密钥',
  'web.keyType': '类型',
  'web.keyComment': '注释',
  'web.generateKeyConfirm': '确定在 ~/.ssh 中创建名为「{0}」的新密钥对？',
  'web.keyGenerated': '已创建密钥「{0}」',
  'web.restoreTitle': '从快照恢复密钥',
  'web.restoreKeys': '恢复密钥',
  'web.restoreConfirm': '将快照中的密钥写入 ~/.ssh？已存在的文件会保留。',
  'web.keysRestored': '已恢复 {0} 个密钥文件',
  'web.keysSkipped': '保留了 {0} 个已存在的文件',
  'web.renameKey': '重命名',
  'web.renameKeyTitle': '重命名密钥',
  'web.newKeyName': '新名称',
  'web.renameConfirm': '确定把「{0}」重命名为「{1}」？使用它的身份会一并更新。',
  'web.keyRenamed': '已将「{0}」重命名为「{1}」',
  'web.keyRenamedIdentities': '已更新 {0} 处身份引用',
  'web.globalIdentityTitle': '全局身份',
  'web.globalIdentityFormHint': '所有没有匹配规则的目录都会使用它。它保存在 ~/.gitconfig，不在 gs 托管块内。',
  'web.globalIdentitySaved': '全局身份已设置为 {0}',
  'web.globalIdentityWas': '原值：{0}',

  // snapshot screen
  'web.snapshotTitle': '迁移',
  'web.exportTitle': '导出快照',
  'web.exportPath': '导出位置',
  'web.exportPathHint': '留空则写入 ~/.config/gs/snapshots/',
  'web.withKeys': '包含私钥（自动加密）',
  'web.passphrase': '口令',
  'web.passphraseHint': '至少 8 个字符；包含私钥时必填',
  'web.exportSnapshot': '导出',
  'web.exported': '快照已写入 {0}',
  'web.exportSummary': '{0} 个文件 · {1} 个身份 · {2} 条规则',
  'web.importTitle': '导入快照',
  'web.importPath': '快照文件',
  'web.remap': '路径改写（旧=新，多个用逗号分隔）',
  'web.remapHint': '可选，例如 D:/CODE=/home/me/code',
  'web.importSnapshot': '导入',
  'web.importConfirm': '用导入的配置替换 ~/.config/gs/profiles.yaml？',
  'web.imported': '已导入 {0} 个身份和 {1} 条规则——打开预览以应用',
  'web.importHasKeys': '快照中包含加密的私钥，可用下方「恢复密钥」写入',
  'web.editIdentity': '编辑',
  'web.saveEdit': '保存修改',
  'web.unknownIdentity': '身份「{0}」已不存在',
  'web.identityUpdated': '已更新身份「{0}」——打开预览以应用',
  'web.editHint': '修改名称时，所有引用它的规则和站点会一并更新。',

  // field labels (used by every form)
  'web.field.name': '名称',
  'web.field.userName': '提交者名称',
  'web.field.email': '提交邮箱',
  'web.field.sshKey': 'SSH 密钥',
  'web.field.siteHost': '主机',
  'web.field.sitePort': '端口',
  'web.field.siteAlias': '别名',
  'web.field.dir': '目录',
  'web.field.identity': '身份',
  'web.field.keyName': '密钥名称',
  'web.field.keyType': '密钥类型',
  'web.field.keyComment': '注释',
  'web.field.snapshot': '快照文件',
  'web.field.passphrase': '口令',
  'web.field.remaps': '路径改写',
  'web.field.root': '扫描根目录',
  'web.field.keyFile': '密钥文件',
  'web.optional': '可选',
  'web.section.identity': '基本信息',
  'web.section.key': 'SSH 密钥',
  'web.section.site': '站点',
  'web.section.target': '目标目录',
  'web.section.assign': '指定身份',
  'web.section.lookup': '选择目录',
  'web.section.import': '从快照导入',
  'web.selectPlaceholder': '— 请选择 —',
  'web.noneOption': '（无）',
  'web.keyfileHint': '~/.ssh 中的文件名，例如 id_ed25519_work',
  'web.keyfileNone': '不指定密钥（该身份不会生成 SSH 路由）',
  'web.hostHint': '例如 github.com',
  'web.portHint': '留空则使用默认端口 22',
  'web.aliasHint': 'SSH 配置里使用的短名，例如 gh',
  'web.dirHint': '绝对路径，例如 D:/CODE/github',
  'web.identityOrderHint': '规则按目录长度优先匹配，越具体的目录越优先。',
  'web.ruleCount': '{0} 条规则',
  'web.keyMissing': '（磁盘上不存在）',
  'web.useThisDir': '使用此目录',
  'web.noKeysYet': '还没有任何 SSH 密钥。请先创建密钥——身份需要密钥才能生成 SSH 路由。',
  'web.goToKeys': '前往密钥页',
  'web.keyRequired': '请先在「密钥」页创建密钥，再回到这里。',
  'web.keyNextStep': '密钥已创建。请把公钥添加到代码托管站点，然后在身份里使用它。',
  'web.goToIdentities': '前往身份页',

  // init screen
  'web.initTitle': '初始化',
  'web.initAlreadyExists': '已存在配置。初始化仅用于全新环境；如需修改请到「身份」页编辑。',
  'web.initDetected': '探测结果',
  'web.initScanning': '正在扫描…',
  'web.initStart': '扫描并生成配置',
  'web.initStartHint': '扫描会读取 SSH 配置与 Git 仓库；在你保存前不会写入任何内容',
  'web.initSaved': '配置已写入——打开预览以应用',
  'web.initOffline': '跳过 SSH 探测（离线）',
  'web.initExistsConfirm': '~/.config/gs/profiles.yaml 已存在，确定覆盖？',
};

const CATALOGUES: Record<Language, Catalogue> = { en, 'zh-CN': zhCN };

/**
 * Translate a key, substituting `{0}`, `{1}`, … Falls back to English, then to
 * the key itself, so a missing entry degrades visibly instead of throwing.
 */
export function t(key: string, ...args: (string | number)[]): string {
  const catalogue = CATALOGUES[current] ?? en;
  let template = catalogue[key] ?? en[key] ?? key;
  args.forEach((value, index) => {
    template = template.split(`{${index}}`).join(String(value));
  });
  return template;
}

/** Exposed for tests: the keys present in a catalogue. */
export function catalogueKeys(lang: Language): string[] {
  return Object.keys(CATALOGUES[lang] ?? {});
}

/**
 * The subset the browser needs.
 *
 * Only `web.*` keys are shipped to the GUI: the rest is CLI text that the page
 * never renders, and keeping the payload small also keeps phrases that merely
 * *mention* private keys out of an API response.
 */
export function webCatalogue(): Catalogue {
  const out: Catalogue = {};
  for (const [key, value] of Object.entries(en)) {
    if (key.startsWith('web.')) out[key] = value;
  }
  for (const [key, value] of Object.entries(CATALOGUES[current] ?? {})) {
    if (key.startsWith('web.')) out[key] = value;
  }
  return out;
}

/** Exposed for the GUI: the whole catalogue for the active language. */
export function activeCatalogue(): Catalogue {
  return { ...en, ...(CATALOGUES[current] ?? {}) };
}