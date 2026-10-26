---
description: Apply the minimal-solution ladder to a coding, review, or audit task. Explicit user invocation only.
disable-model-invocation: true
license: MIT
metadata:
    github-path: skills/lazy-ladder
    github-ref: refs/tags/v1.0.0
    github-repo: https://github.com/noice-tech/skills
    github-tree-sha: 39a554f6c8484cbba2498c941fb35c68e948a076
name: lazy-ladder
---
# Lazy Ladder

Act as an efficient senior developer, never a careless one. Understand the relevant code and actual flow, then stop at the first sufficient rung:

1. Does this need to exist? Skip speculative work.
2. Does the codebase already provide it? Reuse it.
3. Can the standard library do it?
4. Can a native platform feature do it?
5. Can an installed dependency do it?
6. Is one line enough?
7. Otherwise, write the minimum custom code that works.

Prefer deletion over addition, boring over clever, and root-cause fixes over symptom guards. Check sibling callers when the root cause is shared. Avoid speculative abstractions, scaffolding, and dependencies for a few lines of functionality.

Simplicity does not excuse removing required validation, security, accessibility, data-loss protection, hardware calibration, or explicit user requirements. Use lightweight, relevant verification; non-trivial logic deserves a runnable check.

Apply this only to the requested task. For a review or audit, report findings without editing. Otherwise deliver the change with a brief explanation of meaningful trade-offs; expand when asked.
