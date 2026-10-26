---
description: Write standalone public release notes for a version, tag, or range, with a separate private source audit. Explicit user invocation only.
disable-model-invocation: true
license: MIT
metadata:
    github-path: skills/release-notes
    github-ref: refs/tags/v1.0.0
    github-repo: https://github.com/noice-tech/skills
    github-tree-sha: 56e8672fa906924d3e895135260cf39e895cb668
name: release-notes
---
# Release Notes

Write public copy for the requested version, tag, or `from..to` range using Git and GitHub CLI. Resolve the actual release boundary and included changes; ask if ambiguity would materially change the output.

## Sources and classification

The PR body's `## Changelog` → `Public summary` is the canonical public source. When absent, fall back to Changelog Context, the GitHub Release body, PR title, then commit messages. Fallback material is evidence, not automatically publishable text; never turn private background into public claims.

PR types express release intent: `feat` is a new user capability, `fix` corrects a user-visible bug, `improve` improves an existing user-facing workflow, and `internal` has no public product change. Package scopes are metadata, not public wording. Technical maintenance is internal unless its effect is directly user-visible.

Exclude internal-only changes and explicit `None.` summaries. Record contradictions or uncertain public impact in the private audit rather than overriding them silently.

## Public copy

Follow root `.release-notes/style.md` when present. It governs audience, voice, terminology, and presentation, not source priority, classification, or privacy.

Without a style guide, write a plain Markdown bullet list of specific public changes, with no heading, intro, version line, emoji, CTA, or social framing. Public copy must stand alone: no GitHub/release links, PR numbers, hashes, private URLs, private artifact references, internal source notes, or implementation details. Avoid forced hype and generic claims.

If nothing qualifies, write exactly:

```text
No public changelog suggested for this release.
```

## Artifacts

Write public copy to `release-notes/<slug>.md`, using a safe filename derived from the requested version or range (letters, digits, dots, underscores, and hyphens; no path traversal). Refresh an existing generated file for that release, preserving unrelated manual work or asking if ownership is unclear.

Write a separate Markdown source audit in a newly created OS temporary directory outside the repository. Include sources used, changes skipped and why, fallback decisions, and unresolved uncertainty. Do not place the audit in public output or stage it for Git. Temporary storage is not guaranteed confidential storage; avoid copying secrets or unnecessary sensitive text.

Return both paths and a concise summary. Do not commit, push, publish, change PRs, or invoke another skill.
