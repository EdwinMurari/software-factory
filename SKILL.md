---
name: software-factory
description: Build desired product outcomes, review existing work, or investigate and improve supplied audit points, with recorded product decisions, isolated tasks, measured checks, and fresh review. Use for coding work in new or existing projects; scale the workflow to the change.
---

# Software Factory

Turn the user's intended outcome into a working, checked change. The user owns product choices. You own routine engineering within that agreement. Follow the existing project conventions and use its commands. Keep one authoritative implementation per behaviour.

## Choose the input

Accept a desired product outcome, an audit to investigate and improve, or existing work to review. For existing work, read [isolated-runner.md](references/isolated-runner.md), pin an explicit comparison commit for every repository, and use its review input with register/continue. The default fixes scoped findings and repeats fresh checks/reviews to zero findings. “Review only” sets `input.review_only: true`: report findings and check failures without repair or source commits. Resolve material product questions before repair. A missing spec is an explicit report-only limitation, never product approval. For audits, preserve every original point and source. Optional groups need a reason. Read [isolated-runner.md](references/isolated-runner.md) and dispatch fresh read-only investigations. Retain confirmed, disproved and blocked findings, evidence and product questions. Ask the user about one material choice at a time. Record the actual decision reference, including approved deferrals; an investigation result is never approval. Map every point to tasks or an explicit disposition. Blocked points keep the overall work incomplete. Desired outcomes need no artificial audit points.

Use the installed `ask-matt` router to choose external skills within the current stage. Read each selected skill before applying it. The runner enforces execution gates; it does not select workflows or make product decisions.

## Agree on the result

Read the request and relevant code before asking questions. State the intended user outcome, the important acceptance scenarios, and what is outside scope. Keep this in chat for a small change. For multi-session work, use the project's existing spec or task location.

Read [product-contract.md](references/product-contract.md) for new features, vague requests, or conflicting requirements. Resolve material choices about behaviour, scope, architecture, cost, or risk with the user. Offer a recommendation in product terms. Derive test interfaces and routine implementation details yourself; an already agreed decision needs no further approval.

Completion of this stage means an implementer can distinguish the requested result from a plausible but wrong result. Treat unresolved material questions as blocked work, not implicit approval.

## Enter or continue the recorded run

- **Explicit AFK Berry request:** after product intake, use the [AFK route](#explicit-afk-berry-requests).
- **Other explicit factory request:** after product intake, use the v2 lifecycle in [isolated-runner.md](references/isolated-runner.md), even for one small task. Run `register` before application implementation, then `continue` the returned report. Keep that run identity through implementation, checks, reviews and repairs.
- **Implicit small change:** work in the current session with focused checks and review. Substantial work uses the same v2 controller path.
- **Factory worker:** do the assigned stage and return its result schema. The controller owns dispatch, checks, repairs, commits and completion. Do not launch another factory.

After an interruption, continue the existing report. Submit late findings with `reopen`; record retained out-of-run edits with `adopt`. Both return work to the current verification loop. Changed requirements or decisions need a new explicit agreement; adoption accepts source edits only. When the user ends or replaces that agreement, use `close REPORT --reason TEXT` to preserve the incomplete run and release its repository claim before registering the new plan. Obtain completion from `complete`, then report the verified integration worktree and any remaining delivery action. Legacy v1 is retained for existing consumers; new on-demand explicit runs use v2.

Read [quality.md](references/quality.md) when choosing tests, reviewing a change, or handling failed checks. Read [performance.md](references/performance.md) when the change affects responsiveness, caching, large data, background work, or CI cost.

## Build and verify

Implement one behaviour at a time. For new logic or a bug fix, establish a useful failing example before the fix when feasible, then make it pass. Keep the fast loop focused. Run required project checks when the change is coherent; repeat them when a change or unresolved failure warrants it.

Map each acceptance criterion to observed evidence. An exit code proves only that the chosen command passed. Review whether the check exercises the intended behaviour. Missing runtime access, skipped checks, and a passing command that selected zero tests remain gaps.

For a controller run, let its fresh review stages review the complete change against both the product agreement and the project's standards. Include new and uncommitted files. Use a fresh reviewer session with no implementation conversation or earlier review conclusions. Give it the product contract, standards, baseline, current source, and check evidence. Repair findings within scope, rerun affected checks, and repeat fresh reviews until there are no remaining findings. A blocked or interrupted loop is incomplete. Check the combined result after tasks are integrated; individually correct changes can still conflict.

For UI work, exercise the relevant interaction in the running app. For performance claims, compare the same workload before and after and preserve the behaviour. A proxy counter, screenshot, or mock response alone does not prove the user's outcome.

## Finish the agreed work

Stop when the acceptance evidence, relevant checks, and review support the result. On a budget limit, unresolved product decision, unavailable prerequisite, or repeated attempt without progress, return a precise incomplete result with evidence. Preserve the work and failures. Do not weaken a gate to make it pass.

Report the product outcome, essential evidence, remaining gaps, and delivery state. Commit substantial changes as the project requires. Deployment, publishing, and external actions follow the user's actual authorization. Local verification is not field verification, and green checks do not establish bug freedom.

Keep future workflow improvements separate from the current feature. Use a selected retrospective after demonstrated friction; propose policy changes rather than starting an endless self-improvement loop. [sources.md](references/sources.md) records the source lessons, limits, and deliberate adaptations.

## Explicit AFK Berry requests

For an explicit AFK request, read the deployed guide with `ssh gl502 'cat /srv/appdata/berry/projects/services/software-factory/afk/README.md'`. Use the installed `/home/berry/.local/bin/berry-afk` command over SSH to submit the approved immutable spec. Select a registered repository ID and a stable idempotency key. For an unregistered project, ask the operator to register its canonical repository root and existing checks using the deployed guide. Reload registration only when the queue has no running job. Do not auto-enable arbitrary repositories. The service owns planning, worktrees, checks, fresh reviews, repair and integration. Report the job ID and query its durable status. Completion requires a complete job and observed acceptance evidence. Report blocked, cancelled or interrupted work as incomplete. Existing on-demand Python factory interfaces remain available.
