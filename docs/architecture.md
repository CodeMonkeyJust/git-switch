# Architecture

[中文说明](architecture.zh-CN.md)

`gs` is a **generator**: it computes the configuration files that `git` and
`ssh` read, and it diagnoses the resulting environment. It never intercepts or
wraps `git`.

```
┌──────────────────────────────────────────────┐
│  Presenters (thin, optional)                 │
│    src/cli.ts        gs list | diff | apply  │
│    src/server/       gs gui (HTTP + assets)  │
│    web/              plain JS, no framework  │
└───────────────┬──────────────────────────────┘
                │  Plan object
┌───────────────▼──────────────────────────────┐
│  Core  src/core/  — no UI, no argv, no http  │
│    model / yaml / profiles / discover        │
│    managed-block / render/* / checks         │
│    plan  →  apply                            │
└──────────────────────────────────────────────┘
```

The GUI is a **presenter**: `src/server/http.ts` maps HTTP endpoints onto the
same `core` functions the CLI calls, and `web/` is static ES modules. Replacing
the frontend never touches the engine.

## The `Plan` object

`plan()` is the seam between "what would change" and "change it".

- It reads current files and returns `FileOp[]` with `before`/`after` content.
- It is **pure with respect to the filesystem** (reads only).
- The CLI renders a `Plan` as a unified diff; the GUI will render it as a visual
  diff. Both consume the same object, so they cannot disagree.

`apply()` executes a `Plan`:

1. verify each target still holds the content the plan was computed from;
2. back up each file with a timestamp;
3. write atomically (temp file → `fsync` → rename).

## Managed blocks

`gs` edits files it does not own. Everything it writes lives between:

```ini
# >>> gs:managed >>>
…
# <<< gs:managed <<<
```

Rules:

- Content outside the markers is preserved byte-for-byte, including CRLF.
- Duplicate or orphaned markers abort: guessing could corrupt a user file.
- An empty body removes the block entirely rather than leaving empty markers.

## Generated artefacts

| File | Content |
|---|---|
| `~/.gitconfig` | `includeIf "gitdir:<rule>/"` entries pointing at identity configs |
| `~/.config/gs/identities/<name>.gitconfig` | `user.name/email`, credential username, `url.*.insteadOf` |
| `~/.ssh/config` | one `Host <alias>` per site with `IdentityFile` and `IdentitiesOnly yes` |

### Why `includeIf "gitdir:"` and not per-repo config

`gitdir:` keeps the mapping in one place and applies to every repository under a
directory, including subdirectories, without touching each repo.

**Important semantic:** `includeIf "gitdir:..."` is only evaluated while git
resolves a repository. A plain directory with no `.git` will not pick up the
identity — which matches real usage, since you commit inside repositories.

**Format constraints (verified against git for Windows):** the pattern must be
an absolute path with forward slashes and a trailing slash.

### Why SSH aliases instead of plain `Host github.com`

A plain `Host github.com` entry would apply to every repository on the machine
and could conflict with the user's own config. Aliases (`gh`, `pde`) are matched
by `insteadOf` routing, so only repositories routed through the alias use the
intended key.

## Path handling

- Rules are stored with forward slashes and no trailing separator.
- `~` is expanded on load and contracted for display and portability.
- Path matching is case-insensitive on Windows and prefix-safe
  (`/code/git` does not match `/code/githubx`).
