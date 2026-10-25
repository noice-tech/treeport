---
name: commit
description: Commit and push the current changes, then create or update the GitHub pull request with Summary, Changelog, and Verification sections. Use only when the user explicitly asks to commit, push, or open/update a PR.
argument-hint: '[stacked] [--pr|--no-pr] [feat|fix|improve|internal|auto] [summary]'
disable-model-invocation: true
---

# Commit

Commit and push the current changes. Create or update a GitHub pull request unless `--no-pr` is given.

Arguments: `$ARGUMENTS` — if this placeholder was not substituted, use the text the user wrote after the skill name.

## Parse arguments

`[stacked] [--pr|--no-pr] [type] [summary]`, in that order, all optional:

- `stacked` — create a child branch and PR above the current branch's open PR. Follow [stacked.md](stacked.md) instead of the normal workflow. Requires a PR; `stacked --no-pr` is an error.
- `--pr` (default) or `--no-pr` — `--no-pr` commits and pushes without running `gh` or touching any PR.
- `type` — one of `feat`, `fix`, `improve`, `internal`, or `auto`. Missing or `auto`: infer it from the summary, then the session context, then the diff.
- `summary` — the user's rough wording for the current change. It is the primary wording source: convert terse or informal wording into a clear commit message and public summary, using the diff only to verify accuracy and catch important omissions. Do not invent a different story from the diff. If missing or too vague, use the session context and diff.

Unknown `--` options, or both `--pr` and `--no-pr`, stop before any Git change.

Before naming anything, read and follow [changelog-rules.md](changelog-rules.md) for types, commit and PR title format, package scopes, and the Changelog section.

## Normal workflow

1. Inspect `git status`, the current branch, staged and unstaged changes, branch commits, the candidate base branch, any existing PR for the branch, and the workspace package layout.
2. If a PR exists, read its title, base branch, and full body.
3. If there is nothing to commit and no useful PR metadata update, report a no-op.
4. If there are changes and the current branch is `main` (or HEAD is detached), create a branch named `<type>/<short-slug>`.
5. Commit only the intended changes. Do not modify source files unless absolutely required to complete the commit. Do not run broad validation unless it is cheap and relevant; pre-commit hooks run on their own.
6. Resolve the PR title from the cumulative full branch: the existing PR title/body, branch commits, session context, and the full diff against the PR base — after committing, not from the latest commit alone. Use the user's summary for the title only when it represents the whole branch. Keep an existing title's type and scope only if they still match the rules and the full branch.
7. Push, setting upstream when required.
8. No PR: create one against an explicit base (see below). Existing PR: update its title and body to reflect the full branch, preserving its base.

## No-PR workflow (`--no-pr`)

- Do not invoke `gh` at all. Do not inspect, create, or update any PR.
- No changes: report `no_changes` and stop.
- Create a branch only when on `main`; otherwise keep the current branch.
- Commit, push (set upstream if needed), and report `pr: skipped (--no-pr)`.

## PR base branch

- Never rely on `gh pr create`'s implicit base.
- Existing PR: keep its `baseRefName` unless the user explicitly asked to change it.
- New PR: use `git config --get branch.<branch>.gh-merge-base` if set. Otherwise fetch and pick the candidate remote long-lived branch (`main`, `develop`, `staging`, `release/*`, …, excluding the current branch) with the most recent merge-base with `HEAD`.
- Mention a non-default base in the result. If the base is ambiguous, stop and ask instead of opening a PR against the wrong branch.

## PR body

Always write the body to a temp file and pass it by file; never pass Markdown through `--body`.

```sh
tmpdir=$(mktemp -d)
body_file="$tmpdir/pr-body.md"
gh pr create --base "$base_branch" --title "$title" --body-file "$body_file"
```

New PR body:

```md
## Summary

- ...

## Changelog

Public summary:

- One specific standalone user-facing sentence, or `None.` for `internal`.

Context:

- Useful context for future release generation.

## Verification

- Commands run and their outcome, or `Not run`.
```

Updating an existing PR:

- Enhance the existing body; do not blindly replace it. Preserve reviewer notes, checklists, screenshots/videos, testing notes, linked issues, and manual context unless they are now inaccurate.
- Ensure `## Summary`, `## Changelog`, and `## Verification` exist. Refresh `Public summary`, `Context`, and verification to reflect the full branch.
- Do not use `gh pr edit`; it can fail on deprecated Projects Classic GraphQL fields. Use the REST API:

```sh
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
pr_number=$(gh pr view --json number --jq .number)
gh api "repos/$repo/pulls/$pr_number" -X PATCH \
  -f title="$title" -F body=@"$body_file" \
  --jq '.html_url'
```

## Result

Start with one factual sentence of what actually happened, e.g. "Created branch fix/terminal-reattach, committed, pushed, and opened PR #142." On failure, say which steps succeeded and which failed or were not attempted.

Then list, with real values only (`unknown` when unverified):

- `status:` `committed`, `updated_pr`, `no_changes`, or `failed`
- `branch:` name, created or reused (and the starting branch if created)
- `commit:` short SHA and message, or `none`
- `push:` `pushed` to remote/branch, `already up to date`, `not attempted`, or `failed` with reason
- `pr:` `created`, `updated`, or `unchanged` with number, title, and URL; `skipped (--no-pr)`; or `failed` with reason
- `verification:` commands run and outcomes, or `Not run`
- `notes:` important caveats, non-default base, recovery guidance, or `none`

Further commits, pushes, or PR changes need a new user request.
