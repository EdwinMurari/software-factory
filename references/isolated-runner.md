# Recorded factory lifecycle (v2)

The v2 runner uses Python 3.10+, POSIX and Git. It shares v1’s implementation, check, repair and fresh review loop. It adds read-only audit investigation, isolated task worktrees, named repositories and bounded parallel batches. No service, model gateway, scheduler or tracker is required.

## Prepare the input

Start with either the desired outcome or the original audit points and their sources. The coordinator reads installed `ask-matt` and uses its selected external skills. This document is execution guidance, not a skill routing catalogue. Use installed `implement-spec` as the orchestration design reference where relevant. The Python runner neither invokes skill flows itself nor interviews the user.

For an audit, `investigate` actually launches a fresh CLI process per point or explicit group. Investigations run sequentially and read current source, including working changes. Each must account for every supplied point, preserve concrete evidence, and report confirmed, disproved or blocked plus any product questions. Source mutations invalidate the investigation. Fingerprints detect changes; they do not prevent them.

Resolve material choices with the user, one at a time. Preserve the actual answer in a file and reference its SHA-256 in the build plan. A finding is not approval. A task needs its spec pointer, task pointer and required decision IDs. A resolved record requires both a choice and a hashed reference. The controller checks records and freshness, not human identity or whether the recorded statement is true.

An audit build requires a fresh investigation report, an unchanged point/group list, and exactly one mapping per original point. Each question ID needs a decision record. Dependent tasks must include those decision IDs. Every audit implementation mapping also needs an explicit recorded user decision to implement, even when investigation raises no product questions. An unresolved decision stops its mapped tasks and their dependants. A blocked audit point stops its mapped tasks. Independent approved tasks can still integrate; the overall run stays incomplete. The optional `pending_decisions` list is a global stop gate for choices whose scope is not yet known. Deferrals require resolved user decision references and stay listed separately in the report. A disproved mapping must match an actual disproved finding. Desired outcome plans need no audit points.

## Build schema

Paths resolve from the plan’s directory. Keep output outside every source checkout and outside plan/evidence dependencies. All IDs are unique within their domain; acceptance IDs are global. An executable plan is trusted input: review its command arrays and approved scope before launch.

```json
{
  "version": 2,
  "repositories": {"app": "/absolute/path/app", "api": "/absolute/path/api"},
  "worker": {"kind": "codex"},
  "max_workers": 2,
  "worker_timeout_seconds": 900,
  "run_timeout_seconds": 7200,
  "input": {"kind": "outcome", "description": "Save the approved record across app and API"},
  "spec": {"path": "/absolute/path/spec.md", "sha256": "REPLACE_WITH_ACTUAL_HASH"},
  "decisions": [
    {
      "id": "save-policy",
      "status": "resolved",
      "choice": "The recorded user choice about save behaviour",
      "reference": {"path": "/absolute/path/user-answer.md", "sha256": "REPLACE_WITH_ACTUAL_HASH"}
    }
  ],
  "checks": [
    {"id": "app-save", "repo": "app", "argv": ["npm", "test", "--", "save"], "timeout_seconds": 120},
    {"id": "api-save", "repo": "api", "argv": ["python3", "-m", "unittest", "tests.test_save"], "timeout_seconds": 120}
  ],
  "tickets": [
    {
      "id": "save",
      "prompt": "Implement only the approved save scenario from the referenced spec and task",
      "source": {"path": "/absolute/path/save-task.md", "sha256": "REPLACE_WITH_ACTUAL_HASH"},
      "decision_ids": ["save-policy"],
      "repos": ["app", "api"],
      "depends_on": [],
      "checks": ["app-save", "api-save"],
      "acceptance": [{"id": "saved-refresh", "description": "The confirmed saved record survives a fresh read"}]
    }
  ],
  "integration_checks": ["app-save", "api-save"]
}
```

Use the project’s actual commands, spec and acceptance scenarios. `pending_decisions` remains an optional stop gate. Decision records with `status: "pending"` have only `id` and `status`. Build tasks and checks must be nonempty. Each task lists participating repositories; each check targets one named repository. Final checks cover every repository. Repositories must be distinct and nonnested, with initial commits and no submodules. Tasks must form an acyclic dependency graph.

V2 runs checks fresh, even if `cache: true` is supplied for format compatibility. The optional v1 `max_attempts` cap remains available (1–10); omit it for repair until clear. Time limits and repeated source content or no progress stop incomplete. An unchanged failed run should not be relaunched to wait for a lucky pass.

## Audit schema

An investigation intake has `version`, `repositories`, `worker`, `input` and optional time limits or `max_workers`. It has no build fields. The command accepts working changes; isolated builds reject dirty starting checkouts with a preservation instruction.

```json
{
  "version": 2,
  "repositories": {"app": "/absolute/path/app"},
  "worker": {"kind": "claude"},
  "input": {
    "kind": "audit",
    "points": [
      {"id": "lost-save", "description": "Audit point as supplied", "sources": [
        {"path": "/absolute/path/audit.md", "sha256": "REPLACE_WITH_ACTUAL_HASH"}
      ]}
    ],
    "groups": [{"id": "saving", "point_ids": ["lost-save"], "reason": "Same save path"}]
  }
}
```

Groups are optional. Ungrouped points each get a worker. Group IDs must not collide with generated `point-<id>` IDs. Sources are hashed local evidence files; preserve retrieved documents locally when they form an input.

After investigation and actual user decisions, use the build schema, replacing its `input` with the same points/groups and adding:

```json
{
  "kind": "audit",
  "points": ["COPY_THE_UNCHANGED_POINT_OBJECTS"],
  "groups": ["COPY_THE_UNCHANGED_GROUP_OBJECTS_IF_PRESENT"],
  "investigation": {"path": "/absolute/path/investigation/report.json", "sha256": "REPLACE_WITH_ACTUAL_HASH"},
  "mappings": [
    {"point_id": "lost-save", "disposition": "implement", "task_ids": ["save"], "decision_ids": ["save-policy"]}
  ]
}
```

The placeholder arrays above are explanatory, not runnable input. Mapping dispositions are `implement`, `defer`, `disproved` or `blocked`. Only `implement` has task IDs. Deferrals need decision IDs pointing to the recorded user deferral choice. Investigation question IDs are used as the corresponding decision IDs. Changing source (including working edits), audit points, groups, investigation evidence or linked records invalidates the input. Keep the original investigation plan at its recorded path.

## Runnable deterministic examples

These commands create a new disposable fixture, with a custom worker that writes and reads an independently expected file. They need no model or credentials. Choose a new path outside all source repositories:

```sh
python3 scripts/demo.py /tmp/factory-demo
python3 scripts/factory.py validate /tmp/factory-demo/build.json
python3 scripts/factory.py register /tmp/factory-demo/build.json --output-dir /tmp/factory-demo/build-run
python3 scripts/factory.py continue /tmp/factory-demo/build-run/report.json
python3 scripts/factory.py complete /tmp/factory-demo/build-run/report.json
python3 scripts/factory.py validate /tmp/factory-demo/audit.json
python3 scripts/factory.py investigate /tmp/factory-demo/audit.json --output-dir /tmp/factory-demo/audit-run
python3 scripts/factory.py status /tmp/factory-demo/audit-run/report.json
```

The fixture also illustrates the two input files. To run its audit through the build gate, preserve the investigation and generate an execution plan with every point mapped:

```sh
printf '%s\n' 'For this demo, I choose to implement the saved.txt outcome for missing-save.' > /tmp/factory-demo/demo-choice.md
python3 - <<'PY'
import hashlib, json
from pathlib import Path
root = Path('/tmp/factory-demo')
plan = json.loads((root / 'build.json').read_text())
plan['input'] = json.loads((root / 'audit.json').read_text())['input']
report = root / 'audit-run' / 'report.json'
plan['input']['investigation'] = {'path': str(report), 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}
decision = root / 'demo-choice.md'
plan['decisions'] = [{'id': 'demo-choice', 'status': 'resolved', 'choice': 'Implement missing-save',
    'reference': {'path': str(decision), 'sha256': hashlib.sha256(decision.read_bytes()).hexdigest()}}]
plan['tickets'][0]['decision_ids'] = ['demo-choice']
plan['input']['mappings'] = [{'point_id': 'missing-save', 'disposition': 'implement', 'task_ids': ['save'], 'decision_ids': ['demo-choice']}]
(root / 'audit-build.json').write_text(json.dumps(plan, indent=2))
PY
python3 scripts/factory.py run /tmp/factory-demo/audit-build.json --output-dir /tmp/factory-demo/audit-build-run
```

The fixture has a predetermined desired outcome and no product questions. Executing the decision-record command above records your explicit choice for this demo; a real audit needs the actual user response. Its records do not stand in for approval on a real audit. Regression tests additionally exercise overlap, dependencies, conflict repair, linked repositories, cancellation and stale evidence.

## Execution and delivery

`register` records one run identity, its approved inputs and repository ownership before implementation. `continue REPORT` starts or resumes its existing loop. `run` remains a compatibility shortcut for register plus execution. A new output folder cannot bypass an incomplete registered run, including through a linked worktree or legacy build.

Execution pins exact base SHAs and creates a generated integration branch/worktree per repository. It leaves the original checkout and branch unchanged. It takes advisory locks keyed to shared Git directories, so v1 and v2 runs, including runs from different worktrees, cannot race. Stable lock files are retained; process exit releases their locks.

Ready task IDs are sorted into batches of at most `max_workers` (1–32, default 2). Each task gets its own branch and worktree in each participating repository. Tasks in a batch overlap; each implementation, repair and review uses a new CLI process. The coordinator waits for the batch, then integrates in stable ID order. Program Git mutations, including isolated task commits, are serialized. A dependency is ready only when all of its predecessor’s repositories have integrated. A blocked or failed task leaves dependants unrun; independent approved work continues in later batches. The report retains each task’s reason for not running.

The program commits changes **before** check and review evidence is collected. It merges current integration into each task branch. A conflict launches a fresh scoped merger worker with actual Git conflict evidence. The worker resolves source and stages paths; the program commits. No conflict side is selected automatically. The task is checked and freshly reviewed again, then fast-forwarded into each integration branch. Final checks run across the full repository set, followed by a fresh final review. Repairs repeat the same gates; evidence is never relabelled after a later commit.

Codex uses `exec --ephemeral`; Claude uses `--no-session-persistence` and the owner-approved `--dangerously-skip-permissions`. Additional participating roots are supplied through `--add-dir`. Custom adapters get one JSON request on stdin and return the requested result schema on stdout; they must use fresh model sessions. The controller cannot detect hidden adapter history. Review requests contain current requirements, baselines and checks, with no previous review conclusions or implementation conversations. Investigation uses its separate point-disposition schema.

One run deadline bounds all workers and checks. SIGINT, SIGTERM and SIGHUP cancel active process groups, including descendants, and release locks. Git mutations have a 30-second limit. Program Git commands disable hooks, signing and automatic rerere conflict reuse, to avoid hidden commit actions or silent cached conflict choices. Workers still use their installed client policy. The runner is not a sandbox; a deliberately escaping process or ignored external mutation is outside fingerprint guarantees.

A single main report links task logs, original baselines, decisions, point dispositions, dependencies, worktrees, branches, pinned SHAs, checks and reviews. It records final exact repository fingerprints and evidence-file hashes. `status` checks all source repositories, preserved worktrees, the plan, controller modules and referenced evidence. Missing or changed dependencies return stale. Ignored files, symlink targets outside source, environment and external services remain outside source fingerprint coverage; keep runtime checks uncached and preserve external inputs when relevant.

Exit codes: `0` valid, registered, investigated, verified or explicitly closed; `1` incomplete or stale; `2` invalid input or setup error. An `investigated` report records coverage, including blocked points; it is not build success. Read dispositions and evidence, not only the exit code. A verified audit build lists approved deferrals separately from implemented tasks.

All worktrees and local branches remain for inspection, including failures and cancellation. No rollback, reset, clean, push, deployment or issue closing is performed. The persisted integration worktrees/commits are the result; original source branches are not delivery targets. Inspect the report and use the project’s authorized delivery process.

## Continue, reopen and complete

Keep the report path returned by registration. Use these operations on that same report:

```sh
python3 scripts/factory.py continue /absolute/path/run/report.json
python3 scripts/factory.py reopen /absolute/path/run/report.json --findings /absolute/path/findings.json
python3 scripts/factory.py adopt /absolute/path/run/report.json --reason 'Retain the specified correction'
python3 scripts/factory.py complete /absolute/path/run/report.json
```

Findings are a nonempty JSON array of concrete issue strings. Reopening dispatches repair, checks and fresh final review. Continuation restores task worktrees, attempts and logs. Integrated tasks stay integrated; a completed implementation can proceed to checks without being implemented again. Interrupted worker output without a valid result goes to repair. Each operation has a fresh bounded execution deadline. Existing checks and no-progress limits still apply.

Ordinary continuation rejects unexplained worktree changes. Adoption records before/after fingerprints and retained content, then sends it through checks and fresh review. It preserves tracked and untracked edits. The original source checkout, plan, controller, requirements and decision files remain fixed inputs: adoption cannot change them. If they changed, preserve the edits separately and restore the approved inputs before continuing. This interface does not migrate a run to a changed product agreement. When the user explicitly ends or replaces the agreement, run `close REPORT --reason TEXT`. Closing preserves the old report, worktrees and evidence, records the reason, and releases only that run’s repository claims. It can close a run with changed fixed inputs. It never marks the work verified. Then register the newly agreed plan. A closed run cannot be continued.

Repository locks are stable advisory locks, released on process exit. A persistent registry keeps ownership after interruption. If an interrupted worker PID is still alive, continuation stops until it exits. Missing worktrees, missing evidence or unfinished Git conflicts remain visible failures; nothing is reset to make recovery pass. Reports and historical operation snapshots remain in the run directory.

`complete` is the single build completion gate used by run finalization and verified status. It checks the current integration content, required check coverage and process evidence, all acceptance IDs, fresh zero-finding review, integrated task ancestry, unresolved findings, product decisions, source inputs, plan, controller and evidence dependencies. Changing only a status string cannot satisfy it. The result is the recorded integration worktrees; the original branches are not delivery targets.

These controls detect unsupported edits and stale evidence. They do not restrict filesystem permissions, authenticate reports, attest human approval or prove bug freedom. Ignored files, external symlink targets, hidden adapter state and external services remain outside source fingerprint coverage.
