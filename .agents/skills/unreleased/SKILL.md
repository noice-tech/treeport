---
name: unreleased
description: Preview merged PRs since the latest git tag as public candidates, internal/skipped, and needs-cleanup, with a release recommendation. Read-only; replies in chat. Use when asked what is unreleased or whether to cut a release.
---

# Unreleased

Preview what would go into a new release from merged PRs since the latest tag. Do not create tags, releases, commits, branches, PRs, or files. Reply in chat only. Ignore any arguments.

Classify with [changelog-rules.md](../commit/changelog-rules.md).

## Workflow

1. `git fetch --tags`
2. Latest reachable tag: `git describe --tags --abbrev=0`
3. Its commit date: `git log -1 --format=%cI <tag>`
4. Commits since: `git log --oneline <tag>..HEAD`
5. Merged PRs since that date:

   ```sh
   gh pr list --state merged --search "merged:>=YYYY-MM-DD" --limit 200 \
     --json number,title,url,mergedAt,body,mergeCommit,headRefName,baseRefName
   ```

6. Cross-check PRs against commits in `<tag>..HEAD` (e.g. by `mergeCommit` or `(#N)` in squash subjects). Say so if matching is uncertain.
7. Read each relevant PR's title and body (`gh pr view` if needed) and extract `## Changelog` → `Public summary` and `Context`.
8. Classify each PR as a public candidate, internal/skipped, or needs cleanup.

## Classification

Public candidates:

- `feat`, `fix`, or `improve` with a meaningful `Public summary`; use that text as the bullet.
- Be conservative with `fix`: user-visible only.
- User-facing but without a usable public summary → needs cleanup, not a candidate.

Internal/skipped: `internal` PRs and `Public summary: None.`

Needs cleanup:

- missing `## Changelog` or `Public summary`
- vague summary such as "Improved experience" or "Bug fixes"
- `feat`, `fix`, or `improve` with `Public summary: None.`
- title type inconsistent with the changelog body
- user-facing change only discoverable from the title or commits

## Output

```md
Unreleased preview since <latest-tag>

Release recommendation: <yes|maybe|no>

Public candidates: <count>
Internal/skipped: <count>
Needs cleanup: <count>

## Public candidates

- <public summary>
  Source: #<number> <title>

## Internal / skipped

- #<number> <title>
  Reason: <reason>

## Needs cleanup

- #<number> <title>
  Issue: <issue>

## Recommendation

<whether this is worth releasing now and what to clean up first>

## Notes

- <only when relevant: uncertain PR matching, no tag, no gh access, no unreleased commits>
```

No tag: say the preview cannot be anchored and summarize recent merged PRs only if safe. Nothing since the tag: recommend `no`.

Keep it raw and factual. No polished public copy, title, CTA, or marketing framing.
