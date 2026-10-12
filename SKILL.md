---
name: software-factory
description: Build desired product outcomes, review existing work, or investigate and improve supplied audit points, with recorded product decisions, isolated tasks, measured checks, and fresh review. Use for coding work in new or existing projects; scale the workflow to the change.
---

# Software Factory

Turn the user's intended outcome into a working, checked change. The user owns product choices. You own routine engineering within that agreement. Follow the existing project conventions and use its commands. Keep one authoritative implementation per behaviour.

There is one reusable pipeline, with independent instances. Each invocation starts immediately on `gl502` through the installed `berry-afk` CLI. Sandcastle runs fresh agent sessions with `noSandbox()` on the host. Use the installed `ask-matt` router dynamically for external skills, and read each selected skill. This skill holds no skill catalogue.

## Route the request

- **Explicit software-factory request:** finish product intake, then start an independent `build`, `review-repair` or `review-only` run. AFK wording is optional.
- **Implicit small change:** work in the current session with a focused failing example, proportionate checks and review.
- **Implicit substantial change:** do intake, then start an independent run.
- **Factory worker:** perform only the assigned stage and return its result schema. Never launch a nested factory.

## Intake

Read the request and relevant code before asking questions. State the intended outcome, acceptance scenarios and exclusions. Read [product-contract.md](references/product-contract.md) for new features, vague requests or conflicting requirements. Resolve material choices about behaviour, scope, architecture, cost or risk with the user, one at a time, with a recommendation. An investigation or proposal is never approval. Unresolved material choices block execution.

For an audit, investigate during intake. Preserve every original point and source, with evidence for confirmed, disproved and blocked findings. Record actual product decisions and approved deferrals. Start only the approved scope.

## Start and follow a run

Read the deployed guide before invoking the runner:

```sh
ssh gl502 'runner=$(readlink -f /home/berry/.local/bin/berry-afk); cat "$(dirname "$runner")/../README.md"'
```

Use one clean repository and its explicit project config. The config selects trusted checks, provider/model and limits. A scaffold contains config and specs; shared steps stay in the installed factory. No central registration, shared queue or service is required. For unattended execution, use a separate transient unit per invocation as the guide describes.

Copy the approved spec to the host, then start the CLI with `run --config FILE --spec FILE --flow FLOW`. Record the unique run directory printed at startup. Follow that instance with `status RUN_DIRECTORY`; cancel it with `cancel RUN_DIRECTORY`. Both review flows require `--baseline FULL_40_CHARACTER_COMMIT_SHA`. Multiple runs can use the same project with separate worktrees and evidence. Worktrees do not provide a sandbox.

Report the run directory and durable status. Completion requires the runner's complete result plus observed acceptance evidence. A run retains its output branch/worktree and never merges, pushes or deploys by itself. A required-tool preflight runs first; a `blocked` run names the missing tool. `berry-afk preflight --config FILE` inspects tools read-only.

## Merge and clean up

Route a natural-language request such as "use software factory to merge this into main" to `berry-afk merge RUN_DIRECTORY` for the named completed run. Require the user's actual merge authorization, in this request or a durable earlier one; an approved spec or a passing run alone is not authorization. This delivers to **local `main` only**. Push, release and deploy need their own authorization and are never implied.

Report the JSON `status`. For `merge-failed`, give the reason and say a verified merge was not established. Report any retained candidate worktree. For `merged-cleanup-pending`, report the verified merge and the failure reason, plus retained worktrees or branches when listed. Never describe cleanup as complete unless the status is `merged-cleanup-complete`. Use `berry-afk cleanup RUN_DIRECTORY` to reconcile a run merged outside the factory. Retry after the cause is fixed; both commands are repeatable. Do not delete retained work by hand to make cleanup complete. The deployed guide has the exact rules.

## Scope and stops

- One clean repository per run. Whole-codebase review scope must be explicit; there is no automatic per-module coverage guarantee.
- **Review-only** reports findings without repair. Missing requirements remain an explicit limitation, not approval.
- **Review-repair** repeats fresh review and repair until zero findings, passing checks and verified acceptance.
- Limits, timeout, no progress, cancellation, interruption and blockers leave the run incomplete. Never weaken a gate to pass.
- Integration conflicts stop incomplete. Inspect retained work and resolve the cause before a new approved run. There is no automatic conflict repair or resume.
- A run can wait for its own dependencies. It does not wait for another factory user. Preserve other instances and their retained work.

## Quality guidance

Read [quality.md](references/quality.md) when choosing tests, reviewing a change or handling failed checks. Read [testing.md](references/testing.md) for test design. Read [performance.md](references/performance.md) when the change affects responsiveness, caching, large data, background work or CI cost.

Implement one behaviour at a time. For new logic or a bug fix, get a useful failing example first when feasible. Map each acceptance criterion to observed evidence. An exit code proves only that the command passed. A passing command that selected zero tests is a gap. Use a fresh reviewer with no implementation conversation, and review against both the product agreement and project standards. For UI work, exercise the interaction in the running app. For performance claims, compare the same workload before and after.

Deployment, publishing and external actions follow the user's actual authorization. Local verification is not field verification, and green checks do not establish bug freedom. [sources.md](references/sources.md) records the source lessons and limits.
