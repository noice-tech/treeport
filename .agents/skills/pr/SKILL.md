---
description: Commit and push intended changes, and create or update a pull request using Noice product and release conventions. Use when the user asks to commit, push, open a PR, or update a PR.
disable-model-invocation: false
license: MIT
metadata:
    github-path: skills/pr
    github-ref: refs/tags/v1.0.1
    github-repo: https://github.com/noice-tech/skills
    github-tree-sha: c7e3d99f8b57ce5e8529db55a8de1dbcbe01dc75
name: pr
---
# PR

Deliver the requested pull request using Git and GitHub CLI. Match actions to the user's request. Loading this skill does not by itself authorize committing, pushing, or changing a PR. Honor narrower requests such as commit-only, description-only, or preview-only. Leave unrelated work alone. Choose the mechanics appropriate to the repository rather than treating this skill as a Git recipe.

## Naming expresses release intent

Commits use unscoped `type: description`. PR titles use the same format in a single-package repository and `type(package): description` in a multi-package workspace. Use the primary package directory name, or `monorepo` for cross-cutting work.

- `feat`: users can do something new.
- `fix`: a user-visible bug is corrected.
- `improve`: an existing user-facing workflow becomes better.
- `internal`: development or shipping work without a public product change.

Build, CI, tests, dependencies, refactors, and technical corrections are internal unless their effect is directly user-visible. Be concrete, not promotional. A commit describes its change; the PR describes the cumulative branch relative to its intended base. Preserve useful existing PR context.

## Public summary is the product boundary

Every PR has this stable section, consumed by the unreleased and release-notes skills:

```markdown
## Changelog

Public summary:

- One specific, standalone sentence describing the user-facing change.

Context:

- Relevant background for release review; this may be internal.
```

For internal-only work, the public-summary bullet is exactly `None.`. Titles and package scopes are review metadata, not public copy.

Public summaries should stand alone outside a potentially private repository: no GitHub links, PR numbers, hashes, private URLs, or internal implementation details. Avoid vague claims and forced hype. If `.release-notes/style.md` exists at the repository root, follow its audience, voice, and terminology for the summary; its release-level layout does not replace the PR section above.

## Explain with show-me

Find the installed `show-me` skill through the agent's skill discovery mechanism and read its instructions. Use its visual explanation guidance for the PR description. Do not assume a filesystem location. If unavailable, ask the user to install it before proceeding.

Using pr includes reading show-me as supporting guidance, not independently activating it for unrelated tasks. For a PR, use GitHub-renderable Markdown rather than show-me's standalone HTML artifact option. Keep the Changelog contract above intact and state verification honestly.

The release-related skills consume the PR's public summary; do not invoke them automatically. Report the actual outcome, including partial failures, without implying that an unverified push or PR update succeeded.
