# Software Factory

One reusable pipeline. Run as many independent instances as you need.

Give your coding agent a product outcome or a review scope. It resolves product choices with you, then starts a factory run. Each run owns its spec, configuration, evidence and Git worktrees. Other runs can start immediately, including on the same project.

> Use software factory to build [desired product outcome].

> Use software factory to review current work against [full commit ID] and fix findings.

> Review only: use software factory to review the whole codebase against [full commit ID]. Report findings without repairs.

![The build loop: change, checks, fresh review, repair, and final integrated checks.](docs/factory-loop.svg)

The [editable diagram](docs/factory-loop.excalidraw) shows the build flow inside each instance. Shared steps implement planning, implementation, checks, review, repair and integration. Project scaffolds contain configuration, not copies of the controller.

Each review starts a fresh agent session. Findings feed a repair, followed by new checks and another fresh review. Completion requires zero findings, passing checks and verified acceptance. Limits, blockers, cancellation and no progress leave the run incomplete. Review-only reports findings without repairing them.

## Start a run

On gl502, prepare a project config from the [example](afk/deploy/project.example.json). Set the canonical repository path, trusted check commands, agent provider/model and limits. Keep the repository clean. No registration or shared service is needed.

```sh
scp approved-spec.md gl502:/tmp/approved-spec.md
ssh gl502 '/home/berry/.local/bin/berry-afk run --config /path/to/project.json --spec /tmp/approved-spec.md --flow build --output /srv/appdata/berry/state/services/software-factory/runs'
```

The command prints its unique run directory. Use that path to inspect or cancel only that instance:

```sh
ssh gl502 '/home/berry/.local/bin/berry-afk status /path/to/run'
ssh gl502 '/home/berry/.local/bin/berry-afk cancel /path/to/run'
```

Review flows use `--flow review-repair` or `--flow review-only` and require `--baseline FULL_40_CHARACTER_COMMIT_SHA`. For AFK execution that survives logout, start a separate transient unit per run as shown in the [run guide](afk/README.md).

## What stays separate

Runs share the pipeline implementation. Their processes, evidence and output branches are separate. Git worktrees separate source changes; they are not sandboxes. [Sandcastle](https://github.com/mattpocock/sandcastle) executes fresh Codex or Claude sessions with `noSandbox()` on the host.

A run can wait for its own ticket dependencies. It does not wait for another factory user. Integration remains ordered within each run. Output stays in a retained branch/worktree; the pipeline has no push, source-checkout merge or deployment step.

One run targets one clean repository. Whole-codebase review scope must be explicit; the factory gives no automatic per-module coverage guarantee. Product decisions happen during intake. Missing requirements and integration conflicts remain explicit limitations or incomplete work.

## Install and maintain

Install [Matt Pocock's skills](https://github.com/mattpocock/skills), including `ask-matt`, separately. The agent uses that router dynamically; this repository keeps no skill catalogue.

Link this repository as `software-factory` in your Codex or Claude Code skills directory. Inspect existing destinations before replacing them. Berry clients use the shared `agent-skills` catalogue. See the [host installation guide](afk/deploy/README.md) for the executable.

```sh
cd afk
npm ci
npm run typecheck
npm test
```

Read [SKILL.md](SKILL.md) for intake and routing, and the [quality](references/quality.md), [testing](references/testing.md), [performance](references/performance.md) and [source lessons](references/sources.md) when needed. Small implicit edits can use this quality guidance in the current session. Explicit factory requests and substantial work start independent runs.
