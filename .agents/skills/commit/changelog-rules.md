# Changelog rules

Shared by `commit` and `unreleased`.

PR changelog summaries are the source for future public release notes, so each one must stand alone without the PR, its diff, or release links.

## Change types

These express release intent. They are not Conventional Commits.

- `feat` — users can do something new.
- `fix` — a user-visible bug or broken behavior was corrected.
- `improve` — an existing user-facing workflow became clearer, faster, smoother, more reliable, or easier to use.
- `internal` — infra, CI, tooling, refactor, tests, dependencies, logging, or other work that matters to development, release, or reliability but is not a public product change.

Technical-only TypeScript, build, CI, test, dependency, refactor, and internal error-handling fixes are `internal` unless the corrected behavior is directly user-visible.

## Commit messages

Always unscoped: `type: description`.

- `feat: paste files into launcher inputs`
- `fix: stop terminal reattach deadlock after daemon restart`

Do not rewrite existing commits to match a PR title.

## PR titles

This repo is a multi-package workspace, so PR titles use `type(package): description`.

- The scope is the primary package's workspace directory basename (`apps/treeport` → `treeport`, `packages/claude-code` → `claude-code`), not its manifest name.
- Determine the primary package from the PR's intent and the full branch diff against the PR base. Incidental shared-file changes, such as `pnpm-lock.yaml`, do not override a clear primary package.
- Root-only, cross-cutting, or no clear primary package: `type(monorepo): description`.
- Exactly one scope.

Titles are concrete classification and review metadata, not the public changelog source:

- Good: `improve(treeport): open notification center instantly`
- Bad: `improve(treeport): improve terminal experience`

## PR `## Changelog` section

```md
## Changelog

Public summary:

- ...

Context:

- ...
```

- `feat`, `fix`, `improve`: `Public summary` is one specific standalone user-facing sentence, written as if it may become one bullet in a public release post.
- `internal`: `Public summary` is exactly `- None.`
- `Context` can include details that help future release generation.

## Public summary copy

- No links, PR numbers, or commit hashes; understandable without release links.
- Only the user-facing change; no implementation details. Package scopes never appear in it.
- Avoid generic phrases such as "improved experience", "seamless", "empower", and "game-changing".
