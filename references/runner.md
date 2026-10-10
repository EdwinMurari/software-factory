> Legacy v1 compatibility reference. New explicit factory requests use the [v2 lifecycle](isolated-runner.md).

# Version 1: sequential on-demand runner

Version 1 remains supported. For fresh audit investigations, bounded parallel worktrees and linked repositories, use [version 2](isolated-runner.md). Both versions share the worker/check/repair/review engine.

The [controller](../scripts/factory.py) is a Python 3.10+ command for macOS and Linux. It needs Git, a worktree with an initial commit, and an installed/authenticated Codex or Claude Code CLI. It supports any project language through argument-array check commands. Git submodules and native Windows process management are outside this version.

The shared code decides task order, executes checks, requests fresh reviews, bounds repairs, and records evidence. The project supplies its product scenarios and commands. No server, scheduler, provider key, or new model configuration is needed.

## Prepare the project

Use a suitable isolated checkout for substantial work. Preserve any existing user changes. Read project instructions, build/test scripts, CI configuration and relevant code. Discover the actual check commands; do not guess them from the language or require a new test framework.

Agree on material product choices using [product-contract.md](product-contract.md). Translate the agreement into small tasks and checks. Existing task/spec files remain the source of product decisions; refer to them in each prompt. A plan is executable configuration, so review its commands and scope before running it.

Prepare runtime dependencies and a useful check signal before launching the loop. Commands run from the project root and inherit its environment. Use argument arrays, for example `["npm", "run", "check"]`. Use a shell only when a reviewed command genuinely needs shell syntax. Keep tokens and credentials out of the plan and arguments.

Keep the plan outside the worktree or in its established task directory. Keep output outside source. Do not edit the plan while a run is active. A run can change application source, but cannot authorize a product decision, deployment, external message, or publish action.

## Plan format

Here is a small Python example. Replace the prompt, expected behaviour, paths and commands with facts from the actual project. The same format works for other languages.

```json
{
  "version": 1,
  "project": "/absolute/path/to/project",
  "worker": {"kind": "codex"},
  "worker_timeout_seconds": 900,
  "run_timeout_seconds": 3600,
  "pending_decisions": [],
  "checks": [
    {
      "id": "save-tests",
      "argv": ["python3", "-m", "unittest", "tests.test_save"],
      "timeout_seconds": 60
    },
    {
      "id": "project-checks",
      "argv": ["python3", "-m", "unittest", "discover"],
      "timeout_seconds": 120
    }
  ],
  "tickets": [
    {
      "id": "save-note",
      "prompt": "Implement the agreed note-save behaviour in the referenced product spec. Use the existing storage interface. Preserve failure reporting. Stay within this task; provide evidence for its acceptance scenario.",
      "depends_on": [],
      "checks": ["save-tests"],
      "acceptance": [
        {
          "id": "saved-note-survives-refresh",
          "description": "After the app confirms a note is saved, a fresh read returns the same text."
        }
      ]
    }
  ],
  "integration_checks": ["project-checks"]
}
```

Use `{"kind": "claude"}` to select Claude Code. By the owner's explicit choice, factory-launched Claude processes use `claude -p --dangerously-skip-permissions`. This skips Claude's tool permission prompts and grants broad tool access for that worker process. Use trusted projects and a suitable isolated checkout. Task scope, product decisions, and external-action authorization still apply. The controller is not a security sandbox; a source fingerprint can detect some edits after execution, not prevent them.

Both adapters retain the client's configured model and authentication. Codex retains its configured execution policy. The Claude flag affects factory worker launches, not the global Claude configuration. Any remaining authentication, admin-policy or runtime block is reported as incomplete; resolve its cause rather than changing the model or faking a pass.

A built-in worker can set `"executable": "/absolute/path/to/codex"` or the equivalent Claude path. Use this when multiple installed CLI versions exist. Check that the chosen version supports the configured model and structured output. Choose a compatible installed binary rather than silently changing the model or upgrading the user's tools. Custom workers use `argv` instead of `executable`.

Check IDs and ticket IDs must be unique in their groups. Acceptance IDs must be unique across the plan. Every ticket and the integration stage need at least one check. Dependencies must exist and form an acyclic graph. `pending_decisions` prevents execution while a material choice remains unresolved. It is not a substitute for preserving the actual user decision.

## Run and inspect

Run these commands from this repository root, or resolve the equivalent installed skill path:

```sh
python3 scripts/factory.py validate /absolute/path/to/plan.json
python3 scripts/factory.py run /absolute/path/to/plan.json
python3 scripts/factory.py status /absolute/path/to/report.json
```

`run` prints the report path. `--output-dir` selects an empty directory outside the worktree. Default output is a new temporary directory; preserve a needed report in the project's approved evidence storage before that temporary directory is cleaned. Reports and process logs can contain application data. Redact them before sharing.

The loop runs ready tasks in a stable order, one at a time. Each implementation and review starts a fresh agent process. A failed check or review supplies actual evidence to the next repair. There is no attempt-count limit by default: repair and fresh review continue until checks pass, all acceptance criteria are verified, and the reviewer reports zero issues. An optional `max_attempts` from 1 to 10 caps each ticket and integration loop; reaching it is incomplete, not success. Existing plans with this field retain their cap; omit it for the default loop. Worker and whole-run time limits, no source progress, unavailable prerequisites, and unresolved decisions still stop the run as incomplete. The controller checks the integrated result and requests a final review of all criteria and task interactions. A failure that cannot be resolved within the limits ends the run with the work and logs preserved.

Each review receives the current requirements, source baseline, and check evidence. It receives neither earlier review conclusions nor implementation conversation. Codex and Claude launches never resume a session. Fresh context reduces carry-over bias; it does not guarantee an unbiased or exhaustive review.

Checks run fresh by default. A check may declare `"cache": true` only when its relevant inputs are covered by the source fingerprint and it runs deterministically. The runner can then reuse an identical passing command result for the same fingerprint within that run. Source changes require fresh checks. A live service, clock-dependent check, mutable ignored fixture, environment change or external data invalidates that reuse assumption; keep caching off for those checks.

Return codes are `0` for a valid plan or verified run, `1` for an incomplete/stale run, and `2` for invalid input or a setup error. Read the report, not only the exit code. A valid plan is not a verified application.

## Evidence and limits

The fingerprint includes HEAD, index entries, and tracked plus nonignored untracked file contents and modes. It detects staged, unstaged, deleted and new source changes. The plan and controller hashes are also recorded. Checks and reviewers that alter source invalidate their evidence.

Ignored files, external services, secrets, system tools, and symlink target contents outside the repository are not covered by the source fingerprint. Pin or record those inputs when they matter. `status` establishes freshness only within this stated boundary. Local reports are traceable records, not tamper-proof attestations.

The controller requires structured acceptance evidence from workers and reviewers. That remains a model judgement. Review whether assertions are meaningful, tests actually ran, and the user interaction was observed. A command such as `true`, an empty test selection, or a fabricated evidence sentence cannot establish a product outcome even if it fits the schema.

Failed runs preserve edits. This version does not automatically resume, roll back, create worktrees, merge branches, commit, push or deploy. Inspect the result in the current session. Resolve the blocker, preserve useful work, and prepare a bounded next run only when warranted. Do not repeat a run unchanged to wait for a lucky pass.

## Worker extension

A custom worker is `{"kind":"custom","argv":["/path/to/adapter"]}`. It receives one JSON request on stdin, runs in the project root, and must print only one JSON result on stdout. Diagnostics go to stderr. Each invocation must use a fresh model session; the controller cannot verify whether a custom adapter secretly resumes or shares model history. The request includes the phase, ticket or integrated task set, acceptance IDs, evidence, and the result schema.

The result has `status` (`complete`, `changes_requested`, or `blocked`), `summary`, `issues`, and one `acceptance` entry per requested ID. Each entry contains `id`, `status` (`verified` or `pending`), and concrete `evidence`. Review changes require concrete issues. Pending evidence prevents a verified result.

This adapter boundary is the path to Berry LLM Gateway. Before implementing that adapter, use `berry-llm-gateway` and the live Gateway contract. The adapter must provide a real coding-agent tool loop, enforce execution permissions, report usage and stop on budget exhaustion. A model text request alone is not a coding worker. An unattended scheduler is a separate, later decision.

## Maintaining the controller

Run the [regression tests](../scripts/test_factory.py) after changing the controller:

```sh
python3 -m unittest discover -s scripts -p 'test*.py'
```

They use disposable Git repositories and fake workers. They cover control flow and failure handling, not live model quality. After changing a built-in adapter, also run a bounded smoke check with that actual installed CLI and preserve its report.
