# gs — Git & SSH Identity Manager

[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-success)](package.json)

Manage **multiple Git accounts on one machine** without the usual mess.

If you push to GitHub with a personal key, to Gitee with another, and to a
corporate Gitea with a third — and your `~/.gitconfig` / `~/.ssh/config` keep
fighting each other — `gs` turns that into a **declarative, portable, auditable**
configuration.

[中文说明](README.zh-CN.md)

---

## Why

Multi-account Git setups usually break in three places:

| Symptom | Root cause | `gs` fix |
|---|---|---|
| `Permission denied (publickey)` on one host | SSH has no per-host `IdentityFile`, so it tries the wrong key | Managed SSH `Host` blocks, one per identity |
| Commits land with the wrong email | Global `user.email` leaks into every repo | Directory → identity rules via generated `includeIf` |
| Re-configuring a new laptop takes hours | Everything is scattered across files | Portable snapshot + one-command import |

---

## Features

- **Directory → identity mapping** — declarative rules, generated as `gitdir:` `includeIf` blocks
- **Managed config blocks** — writes only inside `# >>> gs:managed >>>` markers; the rest of your files stays byte-for-byte untouched
- **SSH key routing** — per-host `Host` aliases with `IdentitiesOnly yes`, so the wrong key is never offered
- **Safe by default** — atomic writes, timestamped backups, idempotent `apply`
- **Detects concurrent edits** — refuses to overwrite files changed after planning
- **Secrets never stored** — `profiles.yaml` validation rejects passwords, tokens and private keys
- **Zero runtime dependencies** — plain Node, no `node_modules`
- **Bilingual** — the CLI and the GUI both follow the system language (English / 简体中文)

---

## Quick Start

Three ways to run it — pick one:

```bash
# 1. from a checkout: Node runs the TypeScript sources directly (no build needed)
node src/cli.ts init

# 2. install it globally (npm runs `prepare`, which compiles dist/ for you)
npm install -g .
gs init

# 3. build once with the TypeScript compiler, then use the launcher
npm install && npm run build && node dist/gs.mjs init
```

> `dist/` holds **compiled JavaScript**, not TypeScript sources: Node refuses to
> strip types for files inside `node_modules`, so a package shipping `.ts` files
> would not run after installation. TypeScript is a devDependency only — the
> published package still has zero runtime dependencies.

`gs init` reads your machine and proposes a profile:

```
$ gs init
i detected
·   git identity   zhulj <zhulj@pde.com.cn>
·   ssh hosts      3
·   repositories   4
i proposed identities
·   github       zhulj <zhulj@pde.com.cn>  → ssh.github.com
·   pdesoft      zhulj <zhulj@pde.com.cn>  → git.pdesoft.cn
·   gitee        zhulj <zhulj@pde.com.cn>  → gitee.com
i proposed rules
·   ~/code/github  →  github
·   ~/code/gitee  →  gitee
·   ~/code/PDE-GIT  →  pdesoft
! gitee.com: no SSH key associated yet; add sshKey to the identity in profiles.yaml
✓ wrote ~/.config/gs/profiles.yaml
· next: gs diff   (preview)   then   gs apply
```

Then edit `~/.config/gs/profiles.yaml` to taste and apply:

```bash
gs diff     # preview every change
gs apply    # write managed blocks, with backups
```

`gs` looks for its profile at `~/.config/gs/profiles.yaml`:

```yaml
schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519
    sites:
      - host: git.pdesoft.cn
        port: 9092
        alias: pde
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        port: 443
        sshHostName: ssh.github.com    # when the SSH endpoint differs from the host
        alias: gh

rules:
  - dir: D:/CODE/PDE-GIT
    identity: work
  - dir: D:/CODE/github
    identity: personal

settings:
  backupKeep: 20
```

> **About `sshHostName`**: `host` is the Git host that appears in
> `git@github.com:…`; `sshHostName` is the endpoint actually dialled. GitHub needs
> it to reach SSH through `ssh.github.com:443`. Swapping the two produces a
> connection that authenticates and then drops as soon as git asks for a pack.

Then:

```bash
gs diff     # preview every change
gs apply    # write managed blocks, with backups
```

---

## Commands

| Command | Purpose |
|---|---|
| `gs init [--root <dir>] [--force]` | Detect SSH hosts and repositories, write a starter profile |
| `gs list` | Show identities, directory rules and what applies here |
| `gs diff` | Preview every change `gs` would make |
| `gs apply [--dry-run] [--force]` | Write managed blocks to `~/.gitconfig` and `~/.ssh/config` |
| `gs doctor [--online]` | Diagnose keys, ssh config and the identity in this directory |
| `gs gui [--port N] [--no-open]` | Local web UI on `127.0.0.1` |
| `gs key list` | SSH keys with fingerprints and the identities using them |
| `gs key gen <name>` | Create an ed25519 key pair; public key goes to the clipboard |
| `gs key copy <name>` | Copy a public key to the clipboard |
| `gs key restore <snapshot> [--force]` | Write the keys from a snapshot back into `~/.ssh` |
| `gs snapshot export <file> [--with-keys] [--force]` | Write a portable snapshot |
| `gs snapshot import <file> [--remap OLD=NEW] [--force]` | Restore a profile on another machine |

Global options: `--home <dir>` (use an alternative home), `--json`, `--no-color`,
`--lang <en|zh-CN>`.

Exit codes: `0` ok · `1` warning · `2` error.

### Migrating to another computer

```bash
# old machine
gs key list                          # check which keys each identity uses
gs snapshot export backup.gsnap --with-keys   # encrypted: keys included

# new machine
gs snapshot import backup.gsnap --remap D:/CODE=/home/me/code
gs doctor                            # confirms what is still missing
gs apply
```

Notes:

- Without `--with-keys` a snapshot holds **no key material at all**; keys are
  recreated per machine with `gs key gen` (safer: one key per machine).
- With `--with-keys` the whole snapshot is encrypted with scrypt + AES-256-GCM
  and a passphrase you choose (or `GS_PASSPHRASE`). A wrong passphrase fails
  loudly; nothing is written.
- Keys inside a snapshot are **never** written to `~/.ssh` automatically.
- `--remap` rewrites directory rules when the layout differs, matching whole path
  segments only (`D:/CODE` does not touch `D:/CODEX`).
- The snapshot carries only the `gs`-managed block of `~/.ssh/config`, never your
  own entries.

### `gs gui`

An eight-screen local web UI, ordered by the setup dependency chain: **Overview**
(identities, their sites, and the global identity — editable there), **Keys**
(list, copy, generate, rename, restore), **Identities** (add, edit, delete),
**Rules** (directory → identity matrix with a server-side directory picker),
**Preview** (the only screen that writes, always shows the diff first),
**Diagnostics** (the `gs doctor` checks with a re-run button), **Migrate**
(snapshot export/import) and **Setup** (first-run wizard).

```bash
gs gui          # prints http://127.0.0.1:<port>/#token=… and opens it
```

It is plain JavaScript with no build step and no framework, served by the same
zero-dependency Node process as the CLI. Security posture:

| Control | Why |
|---|---|
| binds `127.0.0.1` only | never reachable from the network |
| per-process random token | every request must carry `x-gs-token` |
| `Host` header validation | defeats DNS rebinding |
| `Origin` validation | rejects cross-site requests |
| no CORS headers | browsers cannot read our responses cross-origin |
| strict CSP + `no-store` | no inline script, no cached secrets |
| directory browse limited to allowed roots, `..` rejected | the picker cannot escape home |

The GUI never writes without a plan: **Preview → show diff → confirm → apply**.

### What `gs doctor` catches

```
$ gs doctor
✗ ~/.ssh/id_ed25519_missing does not exist
·    referenced by work; git push/pull will fail with "no such identity"
·    fix: ssh-keygen -t ed25519 -C "<email>" -f "~/.ssh/id_ed25519_missing"
! work: no SSH key configured
✓ ~/.ssh/id_ed25519_github present
✓ ~/.ssh/config managed block present
✓ identity here: zlj20@163.com
! connectivity not probed
·    pass --online to run real ssh handshakes
```

It reports errors first, never throws on a broken key, and prints a concrete
command for each fix. `--online` additionally performs real `ssh -T` handshakes.

---

## How It Works

`gs` never intercepts `git`. It is a **generator** — after `gs apply`, you use
plain `git` and `ssh` as usual.

```
profiles.yaml
      │
      │  gs apply
      ▼
~/.gitconfig                    (includeIf block)
~/.config/gs/identities/*.gitconfig
~/.ssh/config                   (Host block)
      │
      ▼
   git & ssh                    plain, unmodified
```

Generated `~/.gitconfig` block:

```ini
# >>> gs:managed >>>
[includeIf "gitdir:D:/CODE/PDE-GIT/"]
	path = ~/.config/gs/identities/work.gitconfig
[includeIf "gitdir:D:/CODE/github/"]
	path = ~/.config/gs/identities/personal.gitconfig
# <<< gs:managed <<<
```

> **Note:** `includeIf "gitdir:..."` only applies while git resolves a
> repository. Directories configured as rules must contain Git repositories for
> the mapping to take effect — which is exactly how you work.

> **The global identity:** a directory no rule matches falls back to
> `user.name` / `user.email` in `~/.gitconfig`. That value is **not** inside the
> managed block, so `gs list` and the overview screen always name it — a personal
> repository committing with a work address is the exact failure this tool exists
> to prevent.

---

## Safety Model

| Property | Guarantee |
|---|---|
| Foreign content | Preserved byte-for-byte, including CRLF line endings |
| Backups | Every write is preceded by a timestamped backup |
| Idempotency | A second `apply` with no config change writes nothing |
| Concurrency | Refuses to write files changed after planning (`--force` overrides) |
| Markers | Duplicate or orphaned markers abort instead of guessing |
| Secrets | `profiles.yaml` may never contain passwords, tokens or private keys |
| Malformed config | Rejected with a line number or field path, never silently ignored; the UI stays usable and can repair common mistakes in one click |
| Write failures | Reported per file with the real target name and cause; the other files still apply; no temp files leak |
| GUI writes | Identity/rule/snapshot edits only touch `profiles.yaml`; a confirmed Preview is required before anything reaches your system config |

---

## Technical choices

| Choice | Reason |
|---|---|
| Zero runtime dependencies | portable: the published package has no install tree |
| Native TypeScript via Node ≥22.6 type stripping | no build step while developing |
| `tsc` for the published build | Node forbids type stripping inside `node_modules` |
| Hand-written YAML subset | `profiles.yaml` needs a documented subset, not a full parser |
| Plain JS + Web Components for the GUI | no bundler, no framework, ~30 KB of source |
| Generator, not a `git` wrapper | after `gs apply`, plain `git` just works |
| One message catalogue for both surfaces | the CLI and the GUI cannot drift apart; a missing entry falls back to English |

---

## Requirements

- Node.js ≥ 22.6 (native TypeScript type stripping)
- Git 2.36+

Runs on Windows, macOS, and Linux.

---

## Development

```bash
npm install           # devDependencies only (typescript, @types/node)
npm test              # unit + end-to-end tests
npm run typecheck     # tsc --noEmit
npm run build         # compile to dist/ for publishing
```

Every test runs against a **throw-away home directory**; the developer's real
`~/.gitconfig` and `~/.ssh/config` are never touched.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

---

## Roadmap

- [x] M1 — managed blocks, `init` / `apply` / `diff` / `list`
- [x] M2 — `doctor` diagnostics (keys, ssh config, identity resolution)
- [x] M3 — `gs gui` (local web UI, zero dependencies)
- [x] M4 — SSH key management, encrypted snapshots, `export` / `import`
- [x] M5 — GUI parity with the CLI, bilingual output, self-healing config errors

---

## License

MIT
