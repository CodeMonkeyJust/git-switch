# Contributing to gs

[中文说明](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to contribute.

## Ground rules

1. **Never write to the developer's real home directory from code or tests.**
   Every test that touches the filesystem must use a throw-away home
   (`test/helpers/tmp-home.ts`). This is non-negotiable — `gs` edits dotfiles.
2. **`src/core/` must not import from `src/commands/`, `src/server/` or `web/`.**
   The core is shared by the CLI and the future GUI; a UI dependency there breaks
   that contract.
3. **Keep runtime dependencies at zero.** Node standard library only.
4. **Secrets never enter `profiles.yaml`.** Validation already rejects them; do
   not weaken it.

## Development setup

```bash
git clone https://github.com/CodeMonkeyJust/git-switch.git
cd git-switch

node --version   # must be >= 22.6
npm test         # runs unit + e2e tests
npm run typecheck
```

There is no build step for development: Node runs the TypeScript sources
directly via native type stripping.

## Project layout

```
src/
  cli.ts            command-line entry point
  core/             the engine — no UI, no CLI parsing, no framework imports
    model.ts        profiles.yaml schema + validation
    yaml.ts         minimal dependency-free YAML subset
    profiles.ts     load / save profiles
    managed-block.ts  marker block read/write, CRLF preservation
    plan.ts         compute the change set (shared by CLI and GUI)
    apply.ts        execute a plan: backup, guard, atomic write
    render/         gitconfig and ssh-config rendering
  commands/         thin CLI wrappers around core
  util/             atomic fs, logging, diff
test/
  unit/             pure logic
  e2e/              real filesystem + real git, in a temp home
  helpers/tmp-home.ts
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): support repository-level overrides
fix(apply): refuse to overwrite files changed after planning
docs: explain includeIf gitdir semantics
test(e2e): cover CRLF preservation
```

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests. Behaviour changes without tests will not be merged.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Make sure `npm test` and `npm run typecheck` pass locally.

## Reporting bugs

Please include:

- `gs` version (`gs version`)
- OS and Node version
- The output of `gs list` and `gs diff` — **redact paths and emails** if needed
- Whether the directory in question contains a Git repository

**Never paste private keys or tokens into an issue.**
