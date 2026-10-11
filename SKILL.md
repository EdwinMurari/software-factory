---
name: software-factory
description: Build desired product outcomes, review existing work, or investigate and improve supplied audit points, with recorded product decisions, isolated tasks, measured checks, and fresh review. Use for coding work in new or existing projects; scale the workflow to the change.
---

# Software Factory

Turn the user's intended outcome into a working, checked change. The user owns product choices. You own routine engineering within that agreement. Follow the existing project conventions and use its commands. Keep one authoritative implementation per behaviour.

There is one factory: the Berry queue on `gl502`. It runs Sandcastle with `noSandbox()` on the host. Use the installed `ask-matt` router dynamically to pick external skills for the current stage. Read each selected skill before applying it. This skill holds no skill catalogue.

## Route the request

- **Explicit software-factory request** (build, review-repair or review-only; "AFK" wording is optional): finish intake in chat, then submit an approved spec to the Berry queue.
- **Implicit small change:** work in the current session. Use the quality guidance below: a focused failing example, focused checks and a review.
- **Implicit substantial change:** do intake, then submit it to the same queue.
- **Factory worker** (a stage run by the queue): do only the assigned stage and return its result schema. Never launch a nested factory.

## Intake

Read the request and relevant code before asking questions. State the intended outcome, the acceptance scenarios and what is out of scope. Read [product-contract.md](references/product-contract.md) for new features, vague requests or conflicting requirements. Resolve each material choice about behaviour, scope, architecture, cost or risk with the user, one at a time, with a recommendation. An investigation result or a proposal is never approval. An unresolved material question is blocked work.

For an audit, investigate during intake, before submission. Keep every original point and its source. Keep confirmed, disproved and blocked findings with evidence. Record the user's decision for each product question, including approved deferrals. Submit only the approved spec.

## Scope of the queue

- One registered, clean repository per job. There is no multi-repo job.
- Whole-codebase review scope must be stated in the spec. The queue gives no automatic per-module coverage guarantee.
- **Review-only** inspects work against a pinned baseline and reports findings. It does not repair.
- **Review-repair** repeats fresh reviews and repairs until there are zero findings, green checks and verified acceptance.
- Round limits, timeouts, no progress, cancellation and blockers leave the job incomplete. Do not weaken a gate to pass.
- Missing product requirements are an explicit review limitation. A review without a spec reports that limit; it approves nothing.
- An integration conflict stops the job incomplete. No automated conflict-repair worker exists. Inspect the retained work, then submit a newly approved request.
- An interrupted job is incomplete. Inspect the retained work and evidence, then submit a newly approved request with a new key, as the deployed guide describes. No resume, adopt, reopen or close command exists.

## Submit

Read the deployed guide first:

```sh
ssh gl502 'cat /srv/appdata/berry/projects/services/software-factory/afk/README.md'
```

Copy the approved spec to the host, then submit and query:

```sh
scp approved-spec.md gl502:/tmp/approved-spec.md
ssh gl502 '/home/berry/.local/bin/berry-afk submit --repository REGISTERED_ID --flow build --spec /tmp/approved-spec.md --key STABLE_KEY'
ssh gl502 '/home/berry/.local/bin/berry-afk status JOB_ID'
```

Flows are `build`, `review-repair` and `review-only`. The two review flows need `--baseline FULL_40_CHARACTER_COMMIT_SHA`. For an unregistered project, register its repository root and trusted checks through authorized operator access as the guide describes. A coding agent with that access can do this. Report blocked if access or project authorization is missing. Do not auto-enable arbitrary repositories.

Report the job ID and the durable status. Completion needs a complete job and observed acceptance evidence. Report blocked, cancelled or interrupted work as incomplete. The queue does not push or deploy; the retained branch and worktree are the output.

## Quality guidance

Read [quality.md](references/quality.md) when choosing tests, reviewing a change or handling failed checks. Read [testing.md](references/testing.md) for test design. Read [performance.md](references/performance.md) when the change affects responsiveness, caching, large data, background work or CI cost.

Implement one behaviour at a time. For new logic or a bug fix, get a useful failing example first when feasible. Map each acceptance criterion to observed evidence. An exit code proves only that the command passed. A passing command that selected zero tests is a gap. Use a fresh reviewer with no implementation conversation, and review against both the product agreement and project standards. For UI work, exercise the interaction in the running app. For performance claims, compare the same workload before and after.

Deployment, publishing and external actions follow the user's actual authorization. Local verification is not field verification, and green checks do not establish bug freedom. [sources.md](references/sources.md) records the source lessons and limits.
