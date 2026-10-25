---
name: merge
description: Pass signoff, squash-merge the current tree's pull request, then clean up its branch or linked tree. Use only when the user explicitly asks to merge.
disable-model-invocation: true
---

# Merge

Finish and merge the pull request for the current Treeport tree.

Follow this order exactly. If a safe correction is not possible, stop before merge and tree removal, and report the failed check or blocker with the evidence you collected.

## 1. Record the tree

Run `treeport context --json`. Record the exact tree ID, path, branch, kind, project ID, API URL, and project default branch.

- Continue only if this is a managed main or linked tree on an attached non-default branch.
- Do not target a different Treeport daemon. Never remove the main tree.

## 2. Check the pull request

Inspect the current branch, local changes, commits, and pull request. Confirm the pull request head matches the current branch.

- If there is no pull request for this branch, stop and report it.
- In the main tree, require the pull request base to match the project default branch so cleanup returns the checkout to it.

## 3. Make signoff pass

Run `pnpm signoff`. It runs the complete local gate, pushes the branch, and publishes the `signoff` status for the pushed HEAD. It can take a long time; run it in the background if your agent supports that.

- Resolve failures correctly. Do not bypass, weaken, or skip checks.
- Run the smallest relevant checks while fixing.
- Commit all intended changes. Keep generated files and unrelated changes out of the commit.
- Run `pnpm signoff` again after each required fix.

## 4. Wait for checks

Record the signed-off remote HEAD commit and wait for the pull request checks on that exact commit, for example with `gh pr checks --watch`.

- Do not merge while a required check is pending, failing, cancelled, or missing.
- If a check fails, diagnose it, fix it when it is in scope, commit, run `pnpm signoff`, and wait again for the new HEAD.
- Before merging, confirm the remote pull request HEAD is still the signed-off commit and the pull request is mergeable.

## 5. Squash-merge

Merge the recorded pull request from the recorded tree path. Do not use `--admin`, `--auto`, or another merge strategy.

- Main tree: let GitHub CLI delete the branch and switch the checkout back to the pull request base.

  ```sh
  gh pr merge "$pr" --squash --delete-branch --match-head-commit "$sha"
  ```

- Linked tree: run the same command without `--delete-branch`; Treeport cleans up the checkout.

Then confirm `gh pr view "$pr" --json state --jq .state` is `MERGED`.

## 6. Finish

- Main tree: verify the checkout is on the project default branch, report completion, and leave the tree and terminal intact.
- Linked tree: send the user a short completion update with the merged PR, because removal can terminate the current terminal. Then run this as the final command, using the recorded ID and API URL:

  ```sh
  treeport worktree remove "$tree_id" --force
  ```

  The user asked for this removal by invoking the skill. Run no command after it.

Never remove the tree unless the squash merge was confirmed.
