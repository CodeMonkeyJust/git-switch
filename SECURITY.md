# Security Policy

[中文说明](SECURITY.zh-CN.md)

## Supported versions

| Version | Supported |
|---|---|
| 0.x     | ✅ until 1.0 |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub Security Advisories:
<https://github.com/CodeMonkeyJust/git-switch/security/advisories/new>

Include reproduction steps and the affected version. We aim to respond within
7 days.

## Security model

`gs` edits files you own but did not create (`~/.gitconfig`, `~/.ssh/config`) and
manages references to SSH keys. Its design constraints:

### What `gs` stores

| Data | Where | Notes |
|---|---|---|
| Identities (name, email) | `~/.config/gs/profiles.yaml` | Public information |
| Directory rules | `~/.config/gs/profiles.yaml` | Absolute paths |
| SSH key **names** | `profiles.yaml` | Resolved under `~/.ssh`, never copied |
| Backups of edited files | `~/.config/gs/backups/` | Timestamped |

### What `gs` never stores

- Private keys or passphrases
- HTTPS passwords or access tokens
- Anything else that would be dangerous if the profile were committed

`profiles.yaml` is validated on load: any key matching `password`, `passphrase`,
`token`, `secret`, `api_key`, `private_key`, `credential(s)` — and any value
containing a PEM private-key header — causes a hard failure.

Use your OS credential manager for HTTPS and `ssh-agent` for keys.

### Write safety

- Every write is atomic (temp file → `fsync` → rename).
- Every modified file is backed up first.
- A file changed after planning is not overwritten unless `--force` is given.
- Malformed or duplicated block markers abort instead of guessing.

### Scope limits

- `gs` does not intercept `git` or `ssh`; it only generates files they read.
- `gs` never contacts a network service in this version.
- The planned `gs gui` binds to `127.0.0.1` only, with a per-process token,
  `Host`/`Origin` validation, and a strict CSP.
