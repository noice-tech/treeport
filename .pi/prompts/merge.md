---
description: Pass signoff, squash-merge the current PR, and clean up its branch or linked worktree
---

Finish and merge the pull request for the current Treeport worktree.

1. Run `treeport context --json`. Record the exact worktree ID, path, branch, kind, project ID, API URL, and project default branch from this context.
   - Continue only if this is a managed main or linked worktree on an attached non-default branch.
   - Do not target a different Treeport daemon. Do not remove the main worktree.
2. Inspect the current branch, worktree changes, commits, and pull request. Confirm that the pull request head matches the current branch.
   - If there is no pull request for this branch, stop and report the blocker.
   - In the main worktree, require the pull request base to match the project default branch so cleanup returns the checkout to that branch.
3. Make `pnpm signoff` pass.
   - Resolve all failures correctly. Do not bypass, weaken, or skip checks.
   - Run the smallest relevant checks while you make fixes.
   - Commit all intended changes. Keep generated files and unrelated changes out of the commit.
   - Run `pnpm signoff` again after each required fix. Remember that this command runs the complete local gate, pushes the branch, and publishes the `signoff` status for the pushed HEAD.
4. Record the signed-off remote HEAD commit. Wait for the pull request checks for that exact commit to finish.
   - Use GitHub CLI commands such as `gh pr checks --watch` and inspect the pull request state.
   - Do not merge while a required check is pending, failing, cancelled, or missing.
   - If a check fails, diagnose it, fix it when it is in scope, commit the fix, run `pnpm signoff`, and wait again for the new exact HEAD.
   - Before merge, confirm that the remote pull request HEAD is still the signed-off commit and that the pull request is mergeable.
5. Squash-merge the recorded pull request with GitHub CLI, using `--match-head-commit <signed-off-commit>`. Do not use an administrator bypass and do not use a merge method other than squash.
   - Main worktree: run `gh pr merge <recorded-pr-number> --squash --delete-branch --match-head-commit <signed-off-commit>` from the recorded worktree path. Let GitHub CLI delete the merged branch and switch the checkout back to the pull request base (the project default branch, normally `main`).
   - Linked worktree: run the same command without `--delete-branch`; leave checkout cleanup to Treeport.
6. Confirm through GitHub that the recorded pull request state is `MERGED`.
7. Finish according to the recorded worktree kind:
   - Main worktree: verify that the checkout is now on the project default branch. Report completion and leave the worktree and terminal intact. Never run worktree removal for the main worktree.
   - Linked worktree: as the final action, remove it with the Treeport CLI:

     `treeport worktree remove <recorded-worktree-id> --force`

     Use the recorded exact ID and API URL, not a branch-name or path guess. This removal can terminate the current terminal, so send the user a short completion update immediately before you run it. Do not remove the worktree unless the squash merge was confirmed.

If a safe correction is not possible, stop before merge and worktree removal. Report the failed check or blocker and the evidence that you collected.
