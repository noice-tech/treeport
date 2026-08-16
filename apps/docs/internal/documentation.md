# Documentation ownership and release review

This document defines documentation ownership and the release documentation review.

## Ownership

Repository maintainers own the public and internal Treeport documentation.

The author of a product change must update affected documentation in the same change.

The reviewer must confirm that public text describes a supported user contract.

The release owner must complete the release review in this document.

Use these locations:

- Put supported user and integration information in `apps/docs/src/content/docs`.
- Put architecture decisions and contributor constraints in `apps/docs/internal`.
- Put agent-only procedures in the applicable skill.
- Put local implementation constraints in code, tests, or nearby comments.

Use the [writing documentation skill](../../../.agents/skills/writing-docs/SKILL.md) for classification and language rules.

## Review for each release

Complete these steps before `pnpm release:prepare`:

1. Review user-visible changes since the prior release.
2. Update each affected public contract.
3. Remove text about unavailable, removed, or internal functions.
4. Confirm version, platform, dependency, command, and security information.
5. Run the documentation check:

```sh
pnpm --filter @treeport/docs check
```

6. Review the generated site navigation and search.
7. Review the site at narrow and wide viewport sizes.
8. Check keyboard navigation, headings, link text, and visible focus.
9. Check all changed code examples against the release candidate.
10. Check changed external links.
11. Confirm that edit links use the `main` branch.
12. Confirm that no internal document is in the public collection or sidebar.

For a distribution release, also complete these tests on clean supported systems:

1. Install the backend with the documented curl process.
2. Install the backend with the documented npm process.
3. Install the macOS desktop client from the release DMG.
4. Open a repository and connect to its worktree.
5. Run `treeport status`, `treeport doctor`, and `treeport version`.
6. Enable and disable Tailscale Serve remote access.
7. Update the backend with each documented installation method.
8. Install one desktop update from version N-1.
9. Remove Treeport with each documented installation method.

Stop release preparation when a supported workflow does not match the documentation.

Record the mismatch, affected system, command output, and required correction.
