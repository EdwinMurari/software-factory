# Software Factory

An on-demand coding workflow for Codex and Claude Code. It combines a skill for product intent and engineering judgement with a Python controller for task order, checks, fresh reviews, and repairs.

The controller repeats **implement → check → fresh review → repair** until checks pass, all acceptance criteria are verified, and no review findings remain. It then checks and reviews the integrated result. Time limits, blockers, and no progress produce an incomplete result. There is no default attempt-count cap. Explicit `max_attempts` values still apply.

The workflow is deterministic; model output and review quality are not. Green checks do not prove bug freedom.

## Requirements

- Python 3.10+, Git, and macOS or Linux.
- A project Git worktree with an initial commit.
- An authenticated Codex or Claude Code CLI.
- Install [Matt Pocock’s skills](https://github.com/mattpocock/skills) separately, including `ask-matt`. The factory uses that router instead of maintaining another skill catalogue.

## Install the skill

Clone this repository to a stable location. Add a link to that checkout in your client's skill directory:

```sh
git clone git@github.com:EdwinMurari/software-factory.git
cd software-factory
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s "$PWD" ~/.codex/skills/software-factory
ln -s "$PWD" ~/.claude/skills/software-factory
```

If a link already exists, inspect it and use its current source or deliberately replace that link. Restart or reload the client to discover the skill.

Ask: **Use the software factory to build [desired product outcome].** Small changes stay in the current session. Substantial changes use the controller.

## Run the controller

Prepare a plan using the schema and example in [runner.md](references/runner.md). Requirements and check commands belong to the target project.

```sh
python3 scripts/factory.py validate /absolute/path/plan.json
python3 scripts/factory.py run /absolute/path/plan.json
python3 scripts/factory.py status /absolute/path/report.json
```

Each built-in worker starts a new CLI session. Reviews receive requirements, current source, baseline, and check evidence, without earlier review conclusions or implementation conversation. Custom adapters must uphold the same fresh-session contract.

**Claude permission mode:** the built-in Claude worker uses `--dangerously-skip-permissions`, as explicitly selected for the original installation. It bypasses Claude permission prompts. The runner is not a sandbox. Codex inherits its configured permissions.

## Verify

```sh
python3 -m unittest discover -s scripts -p test_factory.py
```

Tests use disposable Git repositories and fake workers. They verify controller behaviour without model calls. They do not establish live model quality.

## Design and sources

- [Skill](SKILL.md): product acceptance and workflow.
- [Runner](references/runner.md): plan format, commands, adapters, limits, and evidence.
- [Source lessons](references/sources.md): article and video findings, with attribution and limits.
- [Quality](references/quality.md) and [performance](references/performance.md): proportionate validation.

This repository was extracted from the Berry skill catalogue at commit `93171ff`. It includes the controller, tests, skill, and supporting references, without unrelated catalogue content. Existing Berry installations continue to use their current catalogue links; this export does not change them. No automatic synchronization between the two repositories is configured.
