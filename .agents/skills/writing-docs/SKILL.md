---
name: writing-docs
description: Rules for writing and reviewing Treeport documentation. Use whenever adding, editing, or reviewing documentation, and whenever deciding whether a code change requires a documentation change.
---

# Writing Treeport documentation

Document Treeport's intentional user contract, not everything visible in the repository or at runtime.

## Classify the information before writing

Choose exactly one destination for each piece of information:

- Put supported workflows and interfaces for Treeport users or integrators in `apps/docs/src/content/docs`.
- Put durable architectural decisions, contributor constraints, and repository workflows in `apps/docs/internal`.
- Put instructions used only by coding agents in the relevant skill.
- Put constraints local to one implementation in the code, a nearby comment, or a behavioral test.
- Do not document temporary, obvious, or nonessential implementation knowledge.

Do not duplicate the same explanation in public and internal documentation.

## Apply the public-contract test

Information belongs in public documentation only when **all three** statements are true:

1. Treeport users or integrators are intentionally expected to use or depend on it.
2. They need the information to install, configure, operate, integrate with, or troubleshoot Treeport.
3. The project is prepared to treat it as a supported interface: changes will be deliberate and accompanied by updated documentation, compatibility handling, or migration guidance as appropriate.

A single **no** excludes the information from public documentation. If support status is unclear, ask the user or maintainer; do not publish it by default.

A public contract can include commands, configuration, protocols, and user-visible behavior. It does not mean that the behavior can never change. It means users are invited to rely on it and changes are managed intentionally.

Existence is not evidence of support. A name or field is not public merely because it appears in source code, command output, logs, tests, a database, a network response, or a generated type.

## Decide whether a code change needs public documentation

Update public documentation when a code change makes an existing public page incorrect or changes information users need for a supported action. Check specifically for changes to:

- installation steps, prerequisites, or supported platforms;
- documented commands, options, defaults, exit behavior, or stable output formats;
- documented configuration names, accepted values, defaults, or precedence;
- supported API or terminal-protocol requests, responses, or events;
- user workflows, safety behavior, security implications, or recovery steps;
- the availability, limitations, or removal of a documented feature.

Do not add public documentation for a refactor, internal migration, test control, debug option, fixture, private feature flag, incidental field, log message, or development safeguard unless the change also alters a supported user contract.

When reviewing a change, state one of these conclusions explicitly:

- **Public docs required:** name the supported user action or interface that changed.
- **Internal or local documentation required:** name the contributor decision or implementation constraint that must be preserved.
- **No documentation required:** state that no supported user contract or durable contributor knowledge changed.

## Keep development mechanisms out of public docs

Do not publish mechanisms used only by Treeport's implementation, tests, CI, development scripts, or maintainers. This includes development-only:

- environment variables, command flags, and feature flags;
- fixtures, test endpoints, fault injection, and debugging controls;
- database fields, internal API fields, and incidental command output;
- process architecture and source-file organization;
- repository setup, release, and maintenance workflows;
- safeguards that users are not expected to invoke or configure.

Put the knowledge where its consumer will find it:

- script usage in the script's help or contributor documentation;
- agent procedures in the relevant skill;
- non-obvious local invariants in code comments;
- behavior guarantees in tests;
- cross-cutting rationale or decisions in `apps/docs/internal`.

Do not create internal documentation merely to inventory an implementation. Add it only when future contributors need durable context that cannot be recovered reliably from the code and tests.

## Describe outcomes, not private mechanisms

Do not turn an internal mechanism into a supported feature by naming it in public documentation.

When an internal mechanism produces supported behavior, document only the user-visible contract. For example, document that Treeport preserves terminals across daemon restarts. Do not name private environment variables or development scripts used to implement or test that behavior.

Public examples must use supported commands, configuration, and values. Never instruct users to rely on an internal fallback or incidental output.

## Use the correct location

- Public product documentation: `apps/docs/src/content/docs`
- Internal decisions and contributor documentation: `apps/docs/internal`
- Agent-specific operating instructions: the relevant skill
- Local implementation details: code, comments, scripts, and tests

Never add internal documentation to the public Starlight content collection or sidebar.

## Final review

For every public section, complete this sentence with a specific action:

> A Treeport user or integrator needs this information because they are expected to _____.

If the blank cannot name a supported action or dependency, remove the section from public documentation and either move it to the correct internal location or do not document it.

Before finishing, verify that:

- every documented command, option, field, variable, and behavior is intentionally supported;
- required, optional, default, and platform-specific behavior is stated explicitly;
- the text describes current behavior rather than a plan, test setup, or implementation detail;
- internal pages were not added to the public content collection or sidebar.
