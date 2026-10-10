# Software Factory

**Tell Codex or Claude Code what you want to build:**

> Use the software factory to build [desired product outcome].

You choose the product behaviour. The agent handles routine engineering, checks the result, and repairs review findings.

![Factory loop: make a change, run checks, get a fresh review, and repair findings until the result is clear. Repeat after integration.](docs/factory-loop.svg)

[Edit the diagram in Excalidraw](docs/factory-loop.excalidraw).

## Start here

1. **Install the tools.** Use macOS or Linux, Python 3.10+, Git, and an authenticated Codex or Claude Code CLI. Install [Matt Pocock’s skills](https://github.com/mattpocock/skills), including `ask-matt`. That skill selects the right workflow; this repository keeps no second catalogue.
2. **Install this skill.** Clone it to a stable location and link it to your client:

   ```sh
   git clone git@github.com:EdwinMurari/software-factory.git
   cd software-factory
   mkdir -p ~/.codex/skills ~/.claude/skills
   ln -s "$PWD" ~/.codex/skills/software-factory
   ln -s "$PWD" ~/.claude/skills/software-factory
   ```

   Use only the link for the client you need. If a destination already exists, inspect it before replacing it. Reload the client or start a new session.

3. **Open your project and use the prompt above.** The agent clarifies material product choices with you. Small changes stay in the current session. Substantial work uses the runner. The runner needs a Git worktree with an initial commit.

## What makes the loop deterministic?

The **skill** guides decisions. The **Python runner** enforces task order, check commands, review gates, and stop conditions. It does not force every normal chat through the runner.

For each task, the runner repeats **change → checks → fresh review → repair**. It checks and reviews the combined result after integration, too.

A run is **verified** only when checks pass, every acceptance criterion has evidence, and the review reports no remaining issues. There is no default attempt-count cap. A configured cap, time limit, blocker, or repair with no source progress leaves the run **incomplete**.

Each built-in review starts a new CLI session. It receives requirements, current code, the starting baseline, and check evidence. It receives no implementation conversation or earlier review conclusions. Fresh context reduces carry-over bias; it cannot guarantee a complete or unbiased review.

The control flow is deterministic. Model output is not. Passing checks do not prove bug freedom.

## Run it directly

**Claude workers bypass permission prompts** with `--dangerously-skip-permissions`. This was the explicit choice for the original installation. The runner is not a sandbox. Codex uses its configured permissions.

1. Prepare a plan from the [runner guide](references/runner.md). Use the target project's requirements and check commands.
2. Validate and run it from this repository:

   ```sh
   python3 scripts/factory.py validate /absolute/path/plan.json
   python3 scripts/factory.py run /absolute/path/plan.json
   ```

3. Read the report at the path printed by the runner. To check its status later:

   ```sh
   python3 scripts/factory.py status /absolute/path/report.json
   ```

Failed runs preserve edits and logs. The runner does not commit, push, or deploy your project.

<details>
<summary><strong>Maintain or extend the factory</strong></summary>

Run the controller tests after changing its code:

```sh
python3 -m unittest discover -s scripts -p test_factory.py
```

These tests use disposable Git repositories and fake workers. They check controller behaviour without model calls. They do not measure live model quality.

- [Skill](SKILL.md): product acceptance and workflow.
- [Runner guide](references/runner.md): plan format, adapters, limits, and evidence.
- [Source lessons](references/sources.md): findings from the articles and videos, with attribution and limits.
- [Quality](references/quality.md) and [performance](references/performance.md): checks suited to the change.

This repository was exported from the Berry skill catalogue at commit `93171ff`. Existing Berry installations still use their catalogue links. The two repositories do not sync automatically.

</details>
