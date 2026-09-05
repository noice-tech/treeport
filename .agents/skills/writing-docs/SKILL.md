---
name: writing-docs
description: Write and review Treeport documentation. Also decide when a code change needs documentation.
---

# Write Treeport documentation

Document the supported Treeport user contract. Do not document all repository or runtime information.

Always write documentation in ASD-STE100 Simplified Technical English.

## Use Simplified Technical English

Apply these rules to documentation, headings, examples, and link text:

- Use approved ASD-STE100 words when they keep the technical meaning.
- Use one word for one meaning.
- Use the same noun for the same item.
- Use short, direct sentences.
- Use a maximum of 20 words in an instruction.
- Use a maximum of 25 words in a description.
- Give one instruction in each sentence.
- Give two instructions together only when the actions occur at the same time.
- Use active voice.
- Use passive voice only when the actor is unknown or not important.
- Write an instruction in the imperative form.
- Start an instruction with an action verb.
- Put a condition before an instruction when the reader must know the condition first.
- Use a maximum of six sentences in one paragraph.
- Use a vertical list for complex text.
- Use the same grammatical structure for all items in a list.
- Use American English spelling.
- Do not use slang, idioms, humor, or decorative language.
- Do not remove articles or other short words to make text shorter.
- Do not use a technical noun as a verb.
- Do not use a technical verb as a noun.
- Keep product names, commands, code, API names, and necessary technical terms unchanged.
- Explain a technical term when its meaning is not clear from the context.

Do not change a technical fact to simplify the language.

When simple text can have two meanings, keep the precise technical term. Then, explain the term.

## Classify the information

Select one location for each piece of information:

- Put supported user and integration information in `apps/docs/src/content/docs`.
- Put coding-agent instructions in the applicable skill.
- Put implementation constraints in code, nearby comments, or behavioral tests.
- Put repository command instructions in script help.
- Do not document temporary, clear, or unnecessary implementation information.

Treat code and tests as the source of truth for implementation and architecture. Do not maintain separate internal documentation.

Use issues and pull requests for proposals, trade-offs, and decision history. Keep necessary implementation rationale in relevant code comments.

## Apply the public contract test

Put information in public documentation only when all these statements are true:

1. Treeport users or integrators are expected to use or depend on it.
2. They need it to install, configure, operate, integrate with, or correct Treeport.
3. The project will manage changes to this information as changes to a supported interface.

If one statement is false, do not put the information in public documentation.

When support status is not clear, ask a maintainer. Do not publish the information by default.

A public contract can include commands, configuration, protocols, and user-visible behavior.

Users can depend on this contract. Change it deliberately, and supply compatibility or migration instructions when necessary.

The presence of a name or field does not make it public.

Do not infer support from source, output, logs, tests, databases, network responses, or generated types.

## Decide when a code change needs documentation

Update public documentation when a change makes a public page incorrect.

Also update it when users need new information for a supported action.

Review these contracts:

- installation, prerequisites, and supported platforms;
- commands, options, defaults, exit behavior, and stable output;
- configuration names, values, defaults, and priority;
- API and terminal protocol requests, responses, and events;
- workflows, safety behavior, security effects, and recovery;
- feature availability, limits, and removal.

Do not publish internal changes.

Examples include refactors, test controls, debug options, fixtures, private flags, incidental fields, logs, and development safeguards.

Update public documentation only when an internal change also changes a supported user contract.

For a review, state one of these conclusions:

- **Public docs required:** Identify the changed user action or interface.
- **Local documentation required:** Identify the necessary code comment, script help, or agent instruction.
- **No documentation required:** State that no user contract or durable contributor information changed.

## Keep development mechanisms private

Do not put implementation, test, CI, or maintainer mechanisms in public documentation.

This rule includes these development-only items:

- environment variables, command options, and feature flags;
- fixtures, test endpoints, fault insertion, and debug controls;
- database fields, internal API fields, and incidental output;
- process architecture and source-file locations;
- repository setup, release, and maintenance workflows;
- safeguards that users do not configure or start.

Put information where its reader will find it:

- Put script instructions in script help.
- Put agent procedures in the applicable skill.
- Put implementation rationale and constraints in relevant code comments.
- Put behavior guarantees in tests.

## Describe results, not private mechanisms

Do not make an internal mechanism public by naming it in public documentation.

Document only its supported result.

For example, state that terminals continue after a daemon restart.

Do not name private variables or development scripts that test this result.

Use only supported commands, configuration, and values in public examples.

Do not tell users to depend on an internal fallback or incidental output.

## Use the correct location

- Public product documentation: `apps/docs/src/content/docs`
- Agent instructions: The applicable skill
- Implementation information: Code, comments, scripts, and tests

Do not add internal documentation to the public Starlight collection or sidebar.

## Complete the final review

For each public section, complete this sentence:

> A Treeport user or integrator needs this information because they are expected to _____.

The answer must identify a supported action or dependency.

If it does not, remove the section. Preserve necessary instructions in code comments, script help, or the applicable skill.

Before completion, verify these conditions:

- Each documented command, option, field, variable, and behavior has support.
- The text clearly identifies required, optional, default, and platform-specific behavior.
- The text describes current behavior, not a plan, test configuration, or implementation detail.
- No internal page is in the public content collection or sidebar.
