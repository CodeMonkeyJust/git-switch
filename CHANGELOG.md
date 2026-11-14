# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`gs gui --home` looks exactly like the real GUI, so a user could configure an
  identity in a sandbox and be confused when their real `~/.ssh` never changed.**
  The command now prints the home it operates on and warns explicitly when it is
  not the real one (`--json` includes `home` and `sandbox` fields), and the page
  shows a persistent banner naming the home — red for a sandbox, neutral for the
  real home. The banner survives tab switches and can be dismissed.
- **The GUI could not be opened at all.** `gs gui` printed a URL like
  `http://127.0.0.1:PORT/#token=…`, but the server required the token for the
  index page too. A browser never sends the URL fragment, so the first request
  for `/` was answered with `{"error":"missing or invalid token"}` and the app
  never loaded. Static assets are now served to loopback without a token
  (`Host`/`Origin` are still enforced), while every `/api/*` request keeps
  requiring it.
- `gs init` now distinguishes "no key exists" from "keys exist but none was
  accepted". The second case is usually a permission or known-hosts problem, and
  the message now says so and points at `gs doctor --online` instead of asking
  for a key that is already there.
- **`gs doctor --online` reported a false authentication failure before the
  first `gs apply`.** It probed the generated host alias, which only exists once
  the managed block has been written, so ssh answered "Could not resolve
  hostname" and a perfectly good profile looked broken. The check now uses the
  alias only when it is actually defined in `~/.ssh/config`, otherwise it probes
  the real host with the key and user pinned explicitly.
- An unresolvable host is now reported as a warning with "could not be
  resolved", not as an authentication failure.
- Private key permissions are checked on **Windows** too. OpenSSH refuses keys
  readable by another principal ("Bad permissions. Try removing permissions for
  user: …"), which previously went undetected: the check only ran on POSIX. The
  ACL is inspected via `icacls`, with `Administrators`, `SYSTEM` and the current
  account correctly treated as expected, and a concrete `icacls` fix suggested.

### Security

- **The secret guard now catches credentials that previously slipped through.**
  `api_secret`, `github_token`, camelCase names like `myPassword`/`apiToken`, and
  values that are recognisably credentials — PGP private keys, `Bearer` tokens,
  JWTs, AWS access key ids, GitHub/GitLab/Slack tokens, `sk-` keys — are all
  refused. Previously only an exact `password`/`token`/`secret` key or an
  `-----BEGIN … PRIVATE KEY-----` value was caught, so pasting a token into a
  comment field stored it in a file meant to be shared.

### Changed

- **The tab bar now follows the setup dependency chain**: Keys → Identities →
  Rules → Preview. A key exists first, an identity uses it, a rule assigns a
  directory to that identity, and only then is there anything to apply.
- The Identities screen warns when no SSH key exists at all and offers a shortcut
  to the Keys screen, instead of letting a user create an identity that cannot
  route SSH. Creating a key now offers the reverse shortcut to Identities.
- **Forms on the identity and rule screens follow the order a user thinks in,
  and every control has a visible label.** Identity: *Basic identity* → *SSH
  key* → *Site*; a rule: *Target directory* → *Assign to an identity*. Labels
  stay visible while typing (placeholders alone disappear), required fields carry
  a `*`, and hints sit beside the label instead of inside the input.
- The SSH key is now a `<select>` of keys that actually exist in `~/.ssh` (plus a
  "no key" option) instead of free text, and the identity for a rule is a
  dropdown that starts on a placeholder rather than silently defaulting to the
  first entry.
- The directory browser fills the field and offers an explicit "Use this
  directory" button, instead of requiring the user to retype the path.
- A rules-screen section was reusing the identity screen's “Basic identity”
  wording; it now says “Assign to an identity”.

### Added

- **Renaming an SSH key.** The Keys screen can rename a key pair on disk; the
  `.pub` companion follows, and every identity or site that referenced the old
  name is rewritten so the profile keeps loading. An existing target, an invalid
  name and a missing source are all refused without touching anything.
- **Setting the global identity.** The overview screen can write `user.name` /
  `user.email` into `~/.gitconfig`. That identity lives *outside* the gs managed
  block, so it is edited directly rather than through `apply` — but only the two
  keys inside `[user]` change: comments, other sections and the managed block are
  preserved, and the previous value is reported back.
- **`gs list` and the GUI overview now name the global identity.** "No matching
  rule — falls back to the global identity" was not actionable without saying
  *which* identity that is; a personal repository committing with a work address
  is the exact failure this tool exists to prevent. The fallback identity is
  printed right under the warning and summarised on the overview screen, and an
  unset global identity is reported explicitly instead of staying silent.
- **Identities can be edited in the GUI**, not just added and deleted. Every
  field is editable — name, commit name/email, SSH key, and the site's
  host/port/alias — and renaming an identity updates every rule, repository
  override and site that refers to it, so the profile keeps loading. Invalid
  input is rejected without touching the file, and a rename onto an existing name
  is refused.
- **The GUI now covers every CLI command.** Three new tabs close the gap:
  - **Keys** — list keys with fingerprints and owning identities, copy a public
    key through the server-side clipboard, generate a new key pair (confirmed
    first), and restore keys from a snapshot. Private key material never reaches
    the browser.
  - **Migrate** — export a snapshot (optionally with keys, always encrypted) and
    import one with path remapping; a failed import leaves the profile untouched.
  - **Setup** — run `gs init` from the browser in two steps: *scan* reports what
    would be written, *save* persists it, and an existing profile is protected.
- A language picker in the header switches between English and Simplified Chinese
  immediately, re-fetching the catalogue and re-rendering the current screen.
- **Identity management in the GUI.** A new **Identities** tab lists every
  identity with its sites, adds one (name, commit name/email, SSH key, optional
  host/port/alias) and deletes one. The server validates the same rules the
  loader enforces — invalid email, bad name, duplicate name, out-of-range port —
  and persists only when the profile is valid, so the UI can never write a file
  that `gs apply` would refuse.
- Deleting is guarded: an identity still referenced by rules needs an explicit
  confirmation, and the **last** identity cannot be deleted at all (an empty
  identities map would make every `gs` command fail to load the profile).
- **Bilingual output (English / Simplified Chinese).** Every CLI message and every
  GUI label now comes from a catalogue. Language precedence is
  `--lang <en|zh-CN>` → `GS_LANG` → the OS locale → English. The GUI receives
  only its own `web.*` strings with `/api/state`, so one switch covers both
  surfaces. A missing translation falls back to English, then to the key, so a
  stale catalogue can never break the CLI.


- `gs key restore <snapshot> [--force]` — write the keys embedded by
  `snapshot export --with-keys` back into `~/.ssh`. Previously the export
  embedded key material and nothing could ever read it back: `--with-keys` was a
  one-way trip. Private keys are restored with mode `600`, existing files are
  kept unless `--force` is given, and `snapshot import` now points at this
  command instead of saying "restore them yourself".
- `npm run audit:coverage` — reports exported symbols the tests never reference.
  This is what surfaced the untested `list`/`diff`/`key`/`doctor`/`snapshot`
  command layer in round 19.
- Tests for `gs doctor`, `gs key` and `gs snapshot` (exit codes, `--json`
  output, overwrite refusal, round-tripped profiles) and for the secret guard
  (33 cases covering what must be blocked and what must still be allowed).
- Tests for `gs list`, `gs diff` and the diff renderer, which had none: the cwd
  resolution, the "no matching rule" warning, `--json` output for both commands,
  that `diff` never writes, and that apply-then-list agree.
- The GUI's ES modules are now **executed** in tests against a DOM shim, so a
  missing function or a wrong call signature fails a test instead of showing a
  blank page. Each of the four screens is rendered and asserted on, a failing API
  call is shown rather than thrown, and the token is verified to travel in the
  `x-gs-token` header. A deliberate mutation was used to confirm the tests catch
  regressions.
- GUI write-path tests: drive the real HTTP endpoints the browser calls
  (plan → apply → plan) and confirm with plain git that the identity took
  effect, that a malformed profile is refused without writing, and that a rule
  added in the UI reaches `~/.gitconfig`.
- `gs init` points at the identities most likely to need a personal address
  (`github`, `gitee`, …) when every identity received the global email, instead
  of a blanket “set a distinct email” hint.
- An end-to-end test builds a realistic code tree (`PDE-GIT`, `github`,
  `MyGithub`, `gitee`), applies, and asserts that plain git resolves a different
  identity per directory — the tool's core promise, verified through git itself.
- `gs init` now **probes which key actually authenticates each site**. A host that
  works through ssh's default key names (`id_ed25519` & co) previously looked
  keyless, so init reported a problem that did not exist. Candidates are tried in
  ssh's own preference order and the winner is written into the profile.
  `--offline` skips the network probes.
- Remote URLs are parsed into host/port/user, so a self-hosted server on a custom
  port (e.g. `ssh://git@git.example.com:9092/...`) is probed on that port instead
  of the default 22.
- Portability test suite covering `~` expansion, home contraction, `gitdir:`
  formatting, Windows-to-POSIX snapshot remapping, and posix path semantics
  verified in-process so the assertions also run on Windows. The `includeIf`
  output was additionally confirmed against a native Linux git.
- `gs key list` / `gs key gen` / `gs key copy` — list SSH keys with fingerprints
  and the identities using them, create an ed25519 pair (public key copied to the
  clipboard), and fetch a public key. Private key material is never written,
  copied or logged.
- `gs snapshot export` / `gs snapshot import` — portable snapshots for moving a
  setup to another machine. Keyless by default; `--with-keys` encrypts the whole
  archive with scrypt (N=16384) + AES-256-GCM. `--remap OLD=NEW` rewrites
  directory rules for a different layout, matching whole path segments only.
  Snapshots carry only the `gs`-managed SSH block, and each file is
  checksum-verified on import.
- `gs gui` — a local web UI bound to `127.0.0.1`, with four screens: Overview,
  directory Rules (with a server-side directory picker), Preview (the only
  screen that writes; always shows the plan diff first) and Diagnostics.
  Implemented as plain ES modules with no framework and no build step, served by
  the same zero-dependency process. Request security: per-process token,
  `Host` and `Origin` validation, no CORS headers, strict CSP, `no-store`.
  Includes single-instance locking and an idle shutdown (default 30 minutes).
- REST endpoints under `/api/`: `state`, `plan`, `apply`, `doctor`, `fs`,
  `rules`.
- `gs doctor` — diagnose the environment without touching it: missing or
  malformed SSH keys, keys referenced by an identity but never created, an
  absent `~/.ssh/config` managed block, aliases shadowed by the user's own
  `Host` entries, and the identity actually resolved for the current directory
  (read from `git config --show-origin`). Reports errors first and prints a
  runnable fix for each. `--online` adds real `ssh -T` handshakes.
- `gs apply` now warns when an identity references an SSH key that does not
  exist, instead of silently writing an unusable `IdentityFile`.
- `gs init` — discover SSH hosts and Git repositories, then write a starter
  `profiles.yaml`. Merges alternate SSH endpoints (`ssh.github.com`) onto their
  canonical host so one account does not produce two identities, and creates
  identities for remote hosts that are missing from `~/.ssh/config`.
- `gs list` — show identities, directory rules, and the rule that applies to the
  current directory.
- `gs diff` — preview every change `gs` would make, with a unified diff.
- `gs apply` — write managed blocks into `~/.gitconfig` and `~/.ssh/config`.
  Supports `--dry-run` and `--force`.
- Managed block engine: content outside `# >>> gs:managed >>>` markers is
  preserved byte-for-byte, including CRLF line endings.
- Declarative `profiles.yaml` (schema version 1) with identities, sites,
  directory rules and repository overrides.
- `site.sshHostName` — dial an alternate SSH endpoint (e.g. `ssh.github.com:443`)
  while keeping the real Git host for URL routing.
- `site.alsoRoutes` — route additional hostnames through one site's alias.
- Dependency-free YAML subset parser with precise error locations.
- Secret guard: `profiles.yaml` rejects passwords, tokens and private keys.
- Per-identity generated git configs with `insteadOf` URL routing covering
  `git@host:`, `https://host/` and `ssh://git@host` remotes.
- SSH `Host` aliases generated with `IdentitiesOnly yes`.
- Timestamped backups before every write; atomic writes.
- Concurrent-edit detection: refuses to overwrite files changed after planning.
- Warning when manual `includeIf` entries or conflicting `Host` entries exist
  outside the managed block.

### Changed

- Removed unreachable exports (`plannedBlockHash`, `readProfilesRaw`,
  `listSshKeys`, `renderProfileText`) that no caller used, found by the new
  coverage audit.

### Fixed

- **A truncated diff hid every added line.** A whole-file rewrite renders as all
  removals followed by all additions, so capping the output with a plain head
  slice showed only deletions — the user approved changes they never saw.
  Truncation now keeps removals and additions in balance and drops context lines
  first.
- `gs diff` wrote its diff bodies straight to `process.stdout`, bypassing the
  logger. Under `--json` that corrupted the JSON document (`Unexpected token
  'i'`), and the output could not be redirected or captured. Commands now write
  through `logger.write`.
- **The test suite was intermittently red.** `gui-command.test.ts` spawned the
  CLI as a child process while the test runner was writing to the same stdio
  channel, corrupting the runner's IPC stream on Windows
  (`Unable to deserialize cloned data`), which failed the whole file with no
  failing assertion. The command is now exercised in-process; five consecutive
  full runs are clean.
- **Sites without a key no longer produce a broken `Host` block.** A `Host` entry
  carrying `IdentitiesOnly yes` but no `IdentityFile` makes ssh fall back to its
  default keys (`id_rsa`, `id_ed25519`, …) — precisely the "wrong key is tried"
  problem gs exists to prevent. Such sites are now skipped, their `insteadOf`
  routing is omitted too (an alias with no Host block would not resolve), and
  `gs plan`/`gs diff` report each skipped site with the fix.
- **A Windows path is now recognised as absolute on every platform.** On Linux,
  `path.isAbsolute('D:\\code\\x')` is false, so a rule written on Windows was
  treated as a *relative* path and joined onto the current directory
  (`/app/D:/code/x`). Since snapshots move between machines, this corrupted
  migrated rules. Drive-letter and UNC paths are now detected independently of
  the host OS.
- **An installed package could not run at all.** `dist/` shipped TypeScript
  sources and relied on Node's runtime type stripping, which Node explicitly
  refuses inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`):
  every `gs` command failed with a stack trace after `npm install -g`. The build
  now compiles with `tsc` (`tsconfig.build.json`) and ships plain JavaScript;
  TypeScript stays a devDependency, so runtime dependencies remain zero.
- `gs gui` returned 500 from a built or installed package because the static
  asset lookup assumed the source layout. All three layouts (checkout, `dist/`,
  installed) are now resolved, with a clear error when none is present.
- Compiling for real surfaced three type errors that runtime stripping had
  hidden: a `promisify(scrypt)` overload losing the KDF options argument and an
  unguarded indexing in the YAML scalar parser. Both are fixed.
- **Packaging.** `dist/` now contains the GUI assets, so an installed package
  can serve `gs gui` (the tarball previously shipped only `dist/src`, making the
  web UI a 404). `npm run build` copies `web/` into `dist/web`, a `prepare` script
  builds automatically on install from a checkout, and asset lookup falls back
  across the development and published layouts with a clear error when neither
  is present.
- Write failures now name the file the user asked to write, not the internal
  `.gs-tmp` file used for the atomic swap, and explain the cause
  (`permission denied — is the file read-only?`, `no space left on device`,
  `filesystem is read-only`, `file is in use`). Temporary files are removed on
  every failure path.
- **Repeatable flags are honoured.** `gs snapshot import` used to keep only the
  last `--remap`, so migrating a machine with several separate code roots only
  rewrote one of them. Every occurrence is now applied in order; single-valued
  flags still take the last value.
- Backup files are now named `gitconfig.20261109-121222.bak` and
  `ssh-config.20261109-121222.bak` instead of encoding the entire absolute path
  with escaped separators, which made the origin of a backup impossible to read.
- `gs init` prints its “detected” section before its discovery warnings; the
  warnings used to appear above the heading they belonged to.
- Discovery warnings show `~/.ssh/config` rather than an absolute machine path.
- `gs list` shows the current directory with forward slashes, matching every
  other path in the output.
- Rule matching is now **case sensitive**, mirroring git's `gitdir:` behaviour.
  `gs` previously matched case-insensitively, so it would report an identity that
  git never actually applied (e.g. rule `/code/github` against a repository in
  `/code/GitHub`).
- Rule paths are aligned with the casing that exists on disk before generating
  `includeIf` entries, so a rule typed in the “wrong” case still works.
  `gitdir/i:` is not honoured by every git build, so normalising the path is the
  reliable fix.
- `gs doctor` now reports a repository that overrides its identity through a
  repository-local `user.email`. Such a value silently beats every directory
  rule, which is the usual reason a migrated repository still commits with the
  old identity.
- `gs doctor` now warns when a wildcard SSH block (`Host *`) pins `IdentityFile`.
  OpenSSH applies wildcard keys before host-specific ones, so the wrong key can
  be offered first even with `IdentitiesOnly yes`.
- `gs init` no longer drops repositories that sit **directly** under the scanned
  root (`code/myrepo`). They were skipped by the grouping step, so no rule was
  proposed for them and those repositories silently kept the global identity.
- The test runner now enforces a minimum test count. `node --test <glob>` exits
  0 with “tests 0” when the pattern matches nothing, which would have let CI go
  green without running a single test.
- `gs key gen` now creates `~/.ssh` when it does not exist; previously it failed
  with `ENOENT` on a fresh machine.
- `ssh://` remotes (typical for self-hosted servers with a custom port) are now
  routed through the identity alias instead of bypassing it.
- A custom port is no longer swallowed into the repository path: rewriting
  `ssh://git@host:9092/path` used to yield the broken `git@alias:9092/path`.
  Port-specific prefixes are now emitted ahead of the bare `ssh://git@host/`
  form, which git's longest-match rule requires.
- `gs init` no longer generates an alias that duplicates a `Host` name already
  present in `~/.ssh/config`; the fallback suffix is `-gs`.

## [0.1.0] - 2026-11-09

- Initial project scaffold.