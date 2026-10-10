---
name: software-factory
description: Build product features, fix app bugs, and improve performance through clear acceptance scenarios, small implementation tasks, measured checks, and review. Use for coding work in new or existing projects; scale the workflow to the change.
---

# Software Factory

Turn the user's intended outcome into a working, checked change. The user owns product choices. You own routine engineering within that agreement. Follow the existing project conventions and use its commands. Keep one authoritative implementation per behaviour.

## Agree on the result

Read the request and relevant code before asking questions. State the intended user outcome, the important acceptance scenarios, and what is outside scope. Keep this in chat for a small change. For multi-session work, use the project's existing spec or task location.

Read [product-contract.md](references/product-contract.md) for new features, vague requests, or conflicting requirements. Resolve material choices about behaviour, scope, architecture, cost, or risk with the user. Offer a recommendation in product terms. Derive test interfaces and routine implementation details yourself; an already agreed decision needs no further approval.

Completion of this stage means an implementer can distinguish the requested result from a plausible but wrong result. Treat unresolved material questions as blocked work, not implicit approval.

## Choose the smallest useful loop

- **Small change:** work in the current session. Use existing focused checks and inspect the result. A copy or style change does not need a ticket graph or new tests.
- **Substantial change:** make small tasks that each deliver observable behaviour. Declare dependencies and acceptance criteria. Read [runner.md](references/runner.md) and use the on-demand runner for fresh worker sessions and deterministic checks. The runner is shared; commands and product requirements belong to the project.
- **Factory worker:** if this session was launched for an assigned implementation, repair, or review stage, do that stage and return the requested result. Do not launch another factory or expand the ticket.

Use the installed `ask-matt` skill as the source for selecting Matt's skills and flows. Read the selected skill before applying it within the agreed scope and current factory stage. Keep skill selection there rather than maintaining a second catalogue in the factory.

Read [quality.md](references/quality.md) when choosing tests, reviewing a change, or handling failed checks. Read [performance.md](references/performance.md) when the change affects responsiveness, caching, large data, background work, or CI cost.

## Build and verify

Implement one behaviour at a time. For new logic or a bug fix, establish a useful failing example before the fix when feasible, then make it pass. Keep the fast loop focused. Run required project checks when the change is coherent; repeat them when a change or unresolved failure warrants it.

Map each acceptance criterion to observed evidence. An exit code proves only that the chosen command passed. Review whether the check exercises the intended behaviour. Missing runtime access, skipped checks, and a passing command that selected zero tests remain gaps.

Review the complete change against both the product agreement and the project's standards. Include new and uncommitted files. Use a fresh reviewer session with no implementation conversation or earlier review conclusions. Give it the product contract, standards, baseline, current source, and check evidence. Repair findings within scope, rerun affected checks, and repeat fresh reviews until there are no remaining findings. A blocked or interrupted loop is incomplete. Check the combined result after tasks are integrated; individually correct changes can still conflict.

For UI work, exercise the relevant interaction in the running app. For performance claims, compare the same workload before and after and preserve the behaviour. A proxy counter, screenshot, or mock response alone does not prove the user's outcome.

## Finish the agreed work

Stop when the acceptance evidence, relevant checks, and review support the result. On a budget limit, unresolved product decision, unavailable prerequisite, or repeated attempt without progress, return a precise incomplete result with evidence. Preserve the work and failures. Do not weaken a gate to make it pass.

Report the product outcome, essential evidence, remaining gaps, and delivery state. Commit substantial changes as the project requires. Deployment, publishing, and external actions follow the user's actual authorization. Local verification is not field verification, and green checks do not establish bug freedom.

Keep future workflow improvements separate from the current feature. Use a selected retrospective after demonstrated friction; propose policy changes rather than starting an endless self-improvement loop. [sources.md](references/sources.md) records the source lessons, limits, and deliberate adaptations.
