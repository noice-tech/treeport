---
description: Pass signoff, squash-merge the current PR, and remove its Treeport worktree
---

Finish and merge the pull request for the current Treeport worktree.

1. Run `treeport context --json`. Record the exact worktree ID, path, branch, kind, project ID, and API URL from this context.
   - Continue only if this is a managed linked worktree on an attached non-default branch.
   - Do not target a different Treeport daemon. Do not remove the main worktree.
2. Inspect the current branch, worktree changes, commits, and pull request. Confirm that the pull request head matches the current branch.
   - If there is no pull request for this branch, stop and report the blocker.
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
5. Squash-merge the pull request with GitHub CLI. Do not use an administrator bypass and do not use a merge method other than squash.
6. Confirm through GitHub that the pull request state is `MERGED`.
7. As the final action, remove the recorded linked worktree with the Treeport CLI:

   `treeport worktree remove <recorded-worktree-id> --force`

   Use the recorded exact ID, not a branch-name or path guess. This removal can terminate the current terminal, so send the user a short completion update immediately before you run it. Do not remove the worktree unless the squash merge was confirmed.

If a safe correction is not possible, stop before merge and worktree removal. Report the failed check or blocker and the evidence that you collected.
