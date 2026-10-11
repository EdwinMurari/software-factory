# Software Factory

Give Codex or Claude Code a build, audit, or review request:

> Use the software factory to build [desired product outcome].

> Use the software factory to investigate and improve [audit points and sources].

> Use software factory to review current work against [baseline] and fix findings.

> Review only: use software factory to review current work against [baseline] and report findings without changing code.

Pin the review baseline to a full commit ID. Supply the approved requirements for repairs. If requirements are missing, review only reports that limitation. Material product decisions still need your choice.

You choose product behaviour, one material decision at a time. The agent uses the installed `ask-matt` router for existing skills, records your decisions, and prepares tasks. Investigation findings never approve a change. This repository keeps no second Matt skill catalogue.

Explicit AFK requests submit an approved spec to the deployed Berry queue; see the [AFK guide](afk/README.md). Other explicit factory requests use the on-demand v2 controller, including one-task changes. Product intake stays in chat. Audits optionally use fresh read-only investigations. The controller builds stable parallel batches in isolated Git worktrees. Dependencies become ready after all participating repositories integrate. Implicit small changes can stay in the current session. Version 1 remains a deliberate legacy interface.

![The shared build loop: change, checks, fresh review, repair, and final integrated checks. Intake and v2 scheduling are described in the runner guide.](docs/factory-loop.svg)

The [editable diagram](docs/factory-loop.excalidraw) shows the shared **build loop**, after intake and scheduling.

## Install

For the on-demand Python controller, use macOS or Linux, Python 3.10+, Git, and an authenticated Codex or Claude Code CLI. Install [Matt Pocock’s skills](https://github.com/mattpocock/skills), including `ask-matt`, separately. Clone this repository to a stable path and link the skill for your client:

```sh
git clone git@github.com:EdwinMurari/software-factory.git
cd software-factory
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s "$PWD" ~/.codex/skills/software-factory
ln -s "$PWD" ~/.claude/skills/software-factory
```

Inspect an existing destination before replacing it. Start a new client session after installation. This repository was exported from Berry’s skill catalogue at commit `93171ff`. Catalogue links and this checkout do not sync automatically.

For the AFK host service, use Node 26 and follow the [deployment guide](afk/deploy/README.md). Its installer creates the `/home/berry/.local/bin/berry-afk` wrapper. Use the [AFK submit, status and cancel examples](afk/README.md#register-and-run) over SSH. An operator registers each repository root and its trusted checks before submission.

## Run

For an explicit AFK request, submit the approved spec with the installed host wrapper:

```sh
ssh gl502 '/home/berry/.local/bin/berry-afk submit --repository REGISTERED_ID --flow build --spec /tmp/approved-spec.md --key STABLE_REQUEST_KEY'
ssh gl502 '/home/berry/.local/bin/berry-afk status JOB_ID'
```

Copy the approved spec to the host first. Follow the [AFK guide](afk/README.md) for review flows, cancellation and completion evidence.

For on-demand requests, follow the [v2 lifecycle guide and runnable examples](references/isolated-runner.md). The [v1 guide](references/runner.md) covers existing legacy consumers. Plans contain trusted executable commands. Claude workers use the owner-approved `--dangerously-skip-permissions`; Codex keeps its configured policy. The runner detects source mutations and stale evidence but is not a security sandbox.

```sh
python3 scripts/factory.py validate /absolute/path/build.json
python3 scripts/factory.py investigate /absolute/path/audit.json
python3 scripts/factory.py register /absolute/path/build.json --output-dir /absolute/path/run
python3 scripts/factory.py continue /absolute/path/run/report.json
python3 scripts/factory.py complete /absolute/path/run/report.json
```

`register` records a build or review run before execution. `continue` restores retained progress; `run` is the compatibility shortcut for both. `reopen REPORT --findings FILE` submits a JSON array of late findings for repair. `adopt REPORT --reason TEXT` records unexplained worktree edits before new checks and fresh review. A different output folder cannot bypass an active run. If the user ends or replaces the agreement, `close REPORT --reason TEXT` preserves its work and evidence, records it as closed without verification, and releases its repository claim.

Success requires green checks, every acceptance criterion verified, and zero review issues on the final exact source state. There is no default attempt cap. Time limits, no progress, cancellation, blockers, and stale evidence leave work incomplete. Explicit audit deferrals remain listed separately.

For existing work, use the [review input schema](references/isolated-runner.md#review-existing-work) with an explicit pinned baseline. Clean and dirty source checkouts are accepted. The default begins with checks and fresh review, repairs scoped findings, and repeats verification. `input.review_only: true` reports findings and failed checks as `reviewed`, with `verified: false` from `complete`/`status`. It performs no repairs or source commits. Both modes preserve the starting checkout, index, working files and file modes.

V2 build and repair create local commits and integration branches. It preserves the starting checkout and all failure worktrees. The controller owns commits and merges; a worker changing Git HEAD invalidates its result. The runner does not push, deploy, or close issues. Reports are evidence records, not proof of human identity or bug freedom.

## Maintain

```sh
python3 -m unittest discover -s scripts -p 'test*.py'
```

Tests use disposable Git repositories and fake workers. They check scheduling, integration, freshness, and failure handling; they do not measure model quality.

Read [SKILL.md](SKILL.md) for the workflow, [quality](references/quality.md) and [performance](references/performance.md) for check selection, and [sources](references/sources.md) for attributed lessons and limits.
