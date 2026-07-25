---
name: writing-tests
description: Rules for writing and reviewing tests in TaskTTY. Use whenever adding, editing, or reviewing tests, especially UI/E2E tests, to keep assertions on user-visible behavior and contracts instead of implementation details like CSS classes, styles, attributes, or markup structure, and to prefer few long workflow tests over many small ones.
---

# Writing Tests

The more a test resembles the way the software is used, the more confidence it gives. Test what users see and do, and what the system promises at its boundaries. A test that breaks when we rename a class, swap a component library, or restyle a button is a cost, not a safety net.

## Assert behavior, not implementation

Good assertions observe outcomes a user or integrator can observe:

- Navigation and URLs, persisted state, reloads restoring the workspace
- Network requests: method, path, exact payload
- WebSocket/terminal protocol messages sent and received
- Rendered text and accessible names, focus, disabled/enabled state
- Elements appearing or disappearing as a result of a user action
- Dialogs, alerts, and error messages the user actually reads

## Never assert

- CSS classes (`toHaveClass`), computed styles (`toHaveCSS`, `toHaveStyle`, `getComputedStyle`), animation names/directions, colors, opacity, typography
- Tailwind utility or state-hook classes (`animate-*`, `latched`, `.selected`, `terminal-*`)
- Library-private attributes (`data-state`, `data-highlighted`, `data-disabled`)
- Markup structure: tag names, `kbd`/`svg`/icon presence, `ul > li` ordering selectors, `option:checked`
- Layout geometry as an assertion target (`clientWidth`/`scrollWidth` comparisons, pixel opacity). Bounding boxes are fine as *inputs* for pointer/touch coordinates.
- Snapshots of class lists, style strings, or whole component markup

If a visual state genuinely matters (a spinner, a highlight, a flash), either it has an accessible representation worth asserting (role, name, `aria-*`) or it is styling and does not need a test.

## Prefer semantic queries

Locate elements the way users find them: `getByRole`, `getByLabel`, `getByText`. CSS selectors are acceptable only as integration hooks into third-party internals with no semantic surface (e.g. xterm's `.xterm-screen`, `.xterm-helper-textarea`, `.xterm-rows`) — and even then, assert focus, text, or protocol output, not xterm's classes.

Use semantic state matchers over attribute inspection: `toBeDisabled()` instead of `data-disabled`, `toBeFocused()` instead of class checks, `getByRole('main', { name: ... })` instead of `main[aria-label=...]`.

## Attributes and ARIA

Do not assert attributes to prove internal state — that includes `aria-*`. If clicking a toggle changes what the terminal receives, assert the terminal input, not `aria-pressed`. Test-only instrumentation attributes used as cross-process probes (e.g. the desktop fixture's `body[data-command]` IPC recorder) are fixtures, not UI assertions, and are fine.

## Write fewer, longer tests

We don't need many tests — we need a few tests that each test a lot in one run. Model each test on a manual tester's workflow: one setup (Arrange), then as many actions and assertions as the workflow needs. A worktree test should create, use, rename-survive, and remove in one flow, the way `app.spec.ts` already does.

- Multiple assertions per test are good. The "one assertion per test" rule existed because old frameworks gave poor failure context; modern runners point at the exact failing line.
- Do not split one workflow into many small `test` blocks connected by shared mutable variables, `beforeAll` chains, or execution order. Each test must be independently runnable and isolated.
- Avoid nested `describe` scaffolding whose only purpose is to share state between steps — inline the flow into one test instead.
- Do not re-render/re-launch the same scenario per assertion; drive one session through the whole path.
- New coverage usually belongs as an extra step or assertion inside an existing workflow test, not as a new test file or block. Add a separate test only for a genuinely distinct scenario (e.g. the failure path).
- A trivial assertion that isn't worth a test of its own (a loading state, an intermediate label) is often worth one line inside a longer flow.

## Redundancy check

Before adding an assertion, ask: does an adjacent assertion already prove this behavior? If a flow already asserts the request payload, the resulting route, and focus, an extra visibility or state check on the same element adds brittleness without confidence. One strong outcome beats three weak observations.

## Heuristic

Before every assertion, ask:

1. Would a user (or API consumer) notice if this failed?
2. Would this survive a pure restyle or component-library swap?

If either answer is no, delete or rewrite the assertion.
