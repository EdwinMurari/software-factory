# Software Factory

Give Codex or Claude Code either input:

> Use the software factory to build [desired product outcome].

> Use the software factory to investigate and improve [audit points and sources].

You choose product behaviour, one material decision at a time. The agent uses the installed `ask-matt` router for existing skills, records your decisions, and prepares tasks. Investigation findings never approve a change. This repository keeps no second Matt skill catalogue.

Small changes stay in the current session. For substantial work, the on-demand Python runner enforces checks and fresh review. Version 1 keeps its sequential checkout workflow. Version 2 investigates audits in fresh read-only processes and builds stable parallel batches in isolated Git worktrees. Dependencies become ready after all participating repositories are integrated.

![The shared build loop: change, checks, fresh review, repair, and final integrated checks. Intake and v2 scheduling are described in the runner guide.](docs/factory-loop.svg)

The [editable diagram](docs/factory-loop.excalidraw) shows the shared **build loop**, after intake and scheduling.

## Install

Use macOS or Linux, Python 3.10+, Git, and an authenticated Codex or Claude Code CLI. Install [Matt Pocock’s skills](https://github.com/mattpocock/skills), including `ask-matt`, separately. Clone this repository to a stable path and link the skill for your client:

```sh
git clone git@github.com:EdwinMurari/software-factory.git
cd software-factory
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s "$PWD" ~/.codex/skills/software-factory
ln -s "$PWD" ~/.claude/skills/software-factory
```

Inspect an existing destination before replacing it. Start a new client session after installation. This repository was exported from Berry’s skill catalogue at commit `93171ff`. Catalogue links and this checkout do not sync automatically.

## Run

Follow the [v1 guide](references/runner.md) or [v2 guide and runnable examples](references/isolated-runner.md). Plans contain trusted executable commands. Claude workers use the owner-approved `--dangerously-skip-permissions`; Codex keeps its configured policy. The runner detects source mutations and stale evidence but is not a security sandbox.

```sh
python3 scripts/factory.py validate /absolute/path/build.json
python3 scripts/factory.py investigate /absolute/path/audit.json
python3 scripts/factory.py run /absolute/path/build.json
python3 scripts/factory.py status /absolute/path/report.json
```

Success requires green checks, every acceptance criterion verified, and zero review issues on the final exact source state. There is no default attempt cap. Time limits, no progress, cancellation, blockers, and stale evidence leave work incomplete. Explicit audit deferrals remain listed separately.

V2 creates local commits and integration branches. It preserves the starting checkout and all failure worktrees. The controller owns commits and merges; a worker changing Git HEAD invalidates its result. The runner does not push, deploy, or close issues. Reports are evidence records, not proof of human identity or bug freedom.

## Maintain

```sh
python3 -m unittest discover -s scripts -p 'test*.py'
```

Tests use disposable Git repositories and fake workers. They check scheduling, integration, freshness, and failure handling; they do not measure model quality.

Read [SKILL.md](SKILL.md) for the workflow, [quality](references/quality.md) and [performance](references/performance.md) for check selection, and [sources](references/sources.md) for attributed lessons and limits.
