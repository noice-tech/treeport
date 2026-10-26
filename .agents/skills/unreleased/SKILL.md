---
description: Preview public release candidates and summary-quality issues since the latest reachable tag, without publishing or editing. Explicit user invocation only.
disable-model-invocation: true
license: MIT
metadata:
    github-path: skills/unreleased
    github-ref: refs/tags/v1.0.0
    github-repo: https://github.com/noice-tech/skills
    github-tree-sha: 8b1b304524dd9548d28aa37fe10d489f04ebabc9
name: unreleased
---
# Unreleased

Assess what is ready for a public release since the latest reachable tag. Use Git and GitHub CLI to establish the actual commit range and included merged PRs; dates alone are not proof of inclusion. Fetch tags if needed. If no tag exists or membership is uncertain, make that limitation explicit rather than inventing a release boundary.

This is a chat-only review: do not edit files or PRs, commit, push, tag, or publish.

## Product boundary

PR titles classify changes as `feat` (new user capability), `fix` (user-visible bug corrected), `improve` (existing user-facing workflow improved), or `internal` (no public product change). Optional package scopes are metadata.

The canonical public source is the PR body's `## Changelog` → `Public summary`. Internal work and summaries marked `None.` stay out of public candidates. Technical/build/CI/test/dependency/refactor changes are internal unless their effect is directly user-visible.

A public candidate needs a specific, standalone user-facing summary, without repository links, PR numbers, hashes, private URLs, or internal details. Flag potentially public changes with missing, vague, private, or contradictory summaries as needing cleanup rather than inventing polished copy. A user-facing title paired with `None.` deserves review, not automatic inclusion.

If root `.release-notes/style.md` exists, use its product terminology and audience to assess summaries; style does not override classification or privacy.

## Review

Give a concise recommendation of yes, maybe, or no, anchored to the inspected range, with:

- Public candidates and their existing summaries.
- Internal/skipped changes and why.
- Summaries needing cleanup and what is wrong.
- Any uncertainty affecting the recommendation.

Include PR references in this internal review so the user can inspect the sources. This is not public release copy, and it does not invoke pr or release-notes.
