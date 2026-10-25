# Stacked commit

`stacked` turns the intended dirty work into a new child branch and PR directly above the current branch's open PR. It overrides every conflicting normal-workflow rule: no existing-PR updates, no cumulative branch prose, no base inference, no ordinary branch creation.

Requires the [`github/gh-stack`](https://github.com/github/gh-stack) extension. `gh stack` is the only authority for stack membership; never read or modify `.git/gh-stack` directly.

## Preflight

Complete all of this before choosing prose or mutating the stack. Any failure stops before `gh stack add`.

1. **Named branch.** Detached HEAD or an unborn branch fails.
2. **Owner.** Resolve `OWNER/REPO` with `gh repo view --json nameWithOwner`.
3. **Exact parent PR.**

   ```sh
   gh pr list --repo "$repo" --head "$current_branch" --state all \
     --json number,title,body,baseRefName,headRefName,headRepositoryOwner,state,url \
     --limit 100
   ```

   Keep PRs whose `headRepositoryOwner.login` equals the repo owner (case-insensitive). Require exactly one, open, with `headRefName` equal to the current branch. Zero, multiple, closed, or merged fail; do not create a replacement.

4. **Published parent.** Refresh origin refs; require `git rev-parse HEAD` to equal `git rev-parse --verify "origin/$current_branch"`. Otherwise ask the user to publish the parent first.
5. **Child work.** Require intended dirty changes. None → report `no_changes` without any stack command. Already-published parent commits are not child work.
6. **Stack state.** Run `gh stack view --json`; parse `trunk`, `currentBranch`, and ordered `branches`. Malformed output is an error. Only if it reports the branch is not in a stack, run `gh stack checkout "$parent_pr_url"`; only if that reports the PR is not in a stack, run `gh stack init --base "$parent_pr_base" "$current_branch"`. Propagate any other error. Re-run `gh stack view --json` and require valid state.
7. **Active top.** `currentBranch` equals the current branch, which is the final branch and not `isMerged` or `isQueued`. Ignore `needsRebase`; never run `gh stack sync` with dirty changes.
8. **Every active layer.** Starting with `active_base = trunk` and skipping merged or queued layers, each layer must have a PR number in `gh stack view`, a local SHA, an `origin/<branch>` SHA equal to it, exactly one same-owner open PR (lookup as above) with the same number, and `baseRefName == active_base`. Advance `active_base` per layer. On failure, suggest `gh stack push` (unpublished commits) or `gh stack submit` (missing or mis-chained PRs).
9. **Snapshot** every active layer's local and remote SHA, and the parent PR's number, title, body, base, head, owner, state, and URL.

## Child branch and PR

- Commit message, PR title, Summary, Changelog, and scope describe only the child work. The parent PR is read-only context; never update its title, body, or base.
- Resolve the commit message first, then derive a fresh `<type>/<slug>` branch. Fail if it already exists locally or on origin.
- Repeat the parent PR lookup; require number, head, base, owner, and open state to match the snapshot.
- Record parent `HEAD`, then `gh stack add "$child_branch"`. Require the current branch to be the child and `HEAD` unchanged.
- Commit the child work; require its parent commit to be the recorded parent `HEAD`.
- Push the child branch explicitly. Do not push or rewrite any other layer.
- Create the PR from a body file in the standard format:

  ```sh
  gh pr create --base "$current_branch" --head "$child_branch" \
    --title "$child_title" --body-file "$body_file"
  ```

  Re-read it and require one same-owner open PR with the expected title, body, base, and head.

## Submit and verify

1. Add the child's local and remote SHA to the snapshot; verify all SHAs.
2. Run `gh stack submit --auto`. Do not run `gh stack sync`.
3. Require the current branch is still the child and every snapshotted SHA is unchanged.
4. Re-read the parent PR and the child PR; require them unchanged.
5. `gh api "repos/$repo/stacks?pull_request=$child_pr_number"` must return exactly one stack whose `pull_requests` place the parent immediately before the child, with the child last.

## Failure

After `gh stack add`, a failure can leave a local child branch, commit, pushed branch, or unsubmitted PR. Never delete, close, reset, rewrite, or reuse that state automatically. Report exactly what exists with manual recovery guidance and `status: failed`.
