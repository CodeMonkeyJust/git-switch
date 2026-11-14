# `profiles.yaml` schema (version 1)

[中文说明](profiles-schema.zh-CN.md)

Located at `~/.config/gs/profiles.yaml`. This file is the single source of truth.

## Top level

```yaml
schemaVersion: 1      # required, integer
identities: {}        # required, at least one
rules: []             # directory -> identity
repositories: []      # per-repository overrides
settings: {}          # optional
```

## identities

```yaml
identities:
  <name>:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519               # optional, file name under ~/.ssh
    credentialUsername: zlj20@163.com # optional, HTTPS credential user
    sites:                           # optional
      - host: git.pdesoft.cn         # required — the REAL git host used in remotes
        port: 9092                   # optional
        user: git                    # optional, defaults to git
        sshKey: id_ed25519           # optional, overrides the identity key
        alias: pde                   # optional SSH alias
        sshHostName: ssh.example.com # optional, endpoint to dial instead of host
        alsoRoutes: [example.com]    # optional, extra hosts routed via this alias
```

- `<name>` may contain letters, digits, `.`, `-`, `_`.
- `user.email` must look like an email address.
- `sshKey` is a **file name only** (`id_ed25519_github`), resolved under `~/.ssh`.
  Absolute paths and path separators are rejected.
- `host` is the Git host that appears in remotes; it drives `insteadOf` routing.
  When the SSH endpoint differs (GitHub over port 443), set `sshHostName` — the
  endpoint is used only for connecting, never for URL rewriting.
- `alsoRoutes` is for extra Git hostnames that should use the same alias, e.g. a
  short company domain alongside the full hostname.

## rules

```yaml
rules:
  - dir: D:/CODE/PDE-GIT
    identity: work
    comment: corporate repositories   # optional, display only
```

- `dir` is normalised to an absolute forward-slash path.
- The **longest matching** rule wins; a rule on `/code` applies to `/code/x`.
- Duplicate `dir` values are rejected.

## repositories

```yaml
repositories:
  - path: D:/CODE/github/old-corporate-repo
    identity: work
```

Repository overrides beat directory rules.

## settings

```yaml
settings:
  backupKeep: 20     # backups to retain
  allowRoots: []     # extra roots the GUI file browser may walk
```

## Forbidden content

Validation rejects any key named `password`, `passphrase`, `token`, `secret`,
`api_key`, `private_key`, `credential` or `credentials`, and any value
containing a private-key header.

`profiles.yaml` must never contain secrets. Use `ssh-agent` for keys and your OS
credential manager for HTTPS.
