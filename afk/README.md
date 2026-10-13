# Independent factory runs

Every `run` invocation executes the shared pipeline in its own process. There is no scheduler, pool, queue, API socket or resident service. Any coding agent can invoke the same CLI. Each worker call uses pinned Sandcastle 0.12.0 and a fresh Codex or Claude session with `noSandbox()`.

Codex workers use “Approve for me”: `on-request` approvals, `auto_review`, and Codex's native `workspace-write` permissions. Sandcastle still runs directly on the host without a container. A small adapter overrides Sandcastle 0.12.0's forced full-access flag; an unexpected upstream command fails closed. Auto-review handles eligible approval requests, not every action. Denied requests can still block a run. Claude's permission mode is unchanged.

## Configure a project

Copy [project.example.json](deploy/project.example.json) to a project-owned configuration file. Set the absolute canonical repository root, standards, trusted checks, provider/model and limits. On Berry, keep configuration under `/srv/appdata/berry/config/software-factory/` and run evidence under `/srv/appdata/berry/state/services/software-factory/runs/`. A config belongs to one project; it is not a central registry. Reuse the same file for independent invocations.

Checks use absolute executable paths and argument arrays, without shell evaluation. The runner pins executables and existing absolute regular-file arguments before execution. Evidence records raw `contentSha256` and metadata-inclusive `fingerprintSha256`, before and after each check. Transitive dependencies, relative arguments and external environment values are not fingerprinted. Use stable, credential-free checks. Configuration authorizes host execution; do not use untrusted commands or place secrets in specs/configs.

The checkout must be clean. Preserve and commit current work before starting. The run snapshots its input and config; later config edits apply to new runs. Project scaffolds contain only this configuration and product specs. Shared TypeScript steps remain the single pipeline implementation.

## Run and inspect

```sh
berry-afk run --config /path/to/project.json --spec /path/to/approved-spec.md --flow build --output /srv/appdata/berry/state/services/software-factory/runs
berry-afk status /path/to/run
berry-afk cancel /path/to/run
```

`run` stays in the foreground and prints its unique run directory before executing the pipeline. `--output` selects the parent for new run directories, not a reusable run ID. Without it, evidence goes under the repository's Git common directory. Status and cancellation take the exact printed run directory. Cancellation requests affect only that instance. Retained work and evidence remain available after success or failure.

For `review-repair` or `review-only`, supply `--baseline FULL_40_CHARACTER_COMMIT_SHA`, an ancestor of current HEAD. Both flows inspect an isolated retained worktree. Review-only dispatches no implementer or repairer. Reviewer/check source writes invalidate the result.

## Required tools

Every `run` proves its required tools before it creates a worktree or starts model planning. Built-in checks cover Git, the selected CLI, its login state, a usable provider home, readable installed `ask-matt`, writable state, run-output and temp locations, and the configured trusted check executables. A login record alone is not enough: Codex must also start its `app-server` with the real provider home and project directory. A login record never proves model entitlement or inference; the report lists `model-inference` as configured but unverified.

Git is checked before repository validation or run storage can be resolved. If Git is unavailable, both `run` and `preflight` return blocked capability JSON and exit 2. The report states that no run started, no durable run directory could be established, and the remaining checks were not run. No worktree or worker starts. When Git is usable, later readiness failures, including a missing or unreadable trusted check executable, remain in the run's durable blocked record.

`preflight.probes` adds absolute-path readiness commands. `preflight.mcpServers` names servers the project needs. Both default to required; set `"required": false` for optional tools. Each probe has a time limit and an output cap, runs in an owned process group, and has secret patterns redacted. Probes must leave source unchanged. A configured MCP server counts as live only after the provider's own connection check: Codex `app-server` `mcpServerStatus/list`, or `claude mcp list`. Anything unsupported or malformed fails a required check. A failed required check ends the run `blocked` with the cause in `events.jsonl`. Optional failures are reported and do not block.

```sh
berry-afk preflight --config /path/to/project.json [--output PARENT_DIR]
```

This inspection runs the same readiness checks without starting a factory run. It reports each capability as `observed`, `configured-unverified` or `unavailable`. It does not copy credentials or print environment values, and it grants no permissions. It does not assume desktop app tools carry over to the CLI. Exit code 2 means a required capability is not observed.

## Merge a completed run into local main

Merging is a separate, deliberate action. A run never merges, pushes or deploys on its own. Invoking `merge` is the delivery authorization. It updates the project's **local** `main` only. Remote push and deployment need their own authorization.

```sh
berry-afk merge /path/to/run
berry-afk cleanup /path/to/run
```

`merge` only accepts a `complete` build or review-repair run. It checks the run identity, snapshots, repository, output branch and commit, the reviewed source hash, and the passing check and review evidence against current Git state. `main` must be checked out, clean, and not in the middle of an operation. If `main` has not moved, it fast-forwards. If `main` has diverged, it merges into an isolated candidate worktree and runs preflight, the configured checks and a fresh review-repair on that candidate first. It then fast-forwards `main` to the candidate only if `main` has not moved again. A conflict, failed review, stale evidence or main movement leaves `main` unchanged and keeps all work. Nothing is forced.

One delivery per repository holds a kernel lease on `delivery.lock` through Linux `flock`. A concurrent merge or cleanup is rejected immediately. Builds do not take this lock. The supervised owner releases the lease when it exits or crashes. The lock file stays in place; it is never renamed or deleted for stale recovery. Missing `flock` blocks delivery.

Output is JSON with one `status`:

- `merge-failed` has a `reason`. A verified merge was not established. A preserved candidate is named in `candidate`.
- `merged-cleanup-pending` means main was verified to contain the work, but cleanup or receipt persistence did not complete. `cleanup.retained` lists retained items when available; `reason` reports an interruption or other failure.
- `merged-cleanup-complete` means main contains the work and every owned worktree and branch is gone.

Exit codes are 2, 3 and 0 in that order. `delivery.json` in the run directory is the durable receipt of the merge and of each cleanup item. Repeating `merge` after any interruption never merges twice and does not need removed worktrees. Run records from before this feature have no provenance, so they cannot be merged or cleaned; their work is retained.

Cleanup starts only after main is shown to contain the accepted output. New runs record each ticket's commits and the cherry-picked commit each became on the integration branch. Inclusion means the picked commits are ancestors of main and `git cherry` finds no missing change; a plain ancestor test cannot prove this for cherry-picked tickets. Before each removal the run checks the registered path, branch and head against the record. It keeps a worktree when it is a symlink, foreign, not registered for the recorded branch, at a different head, used by a running process, holds uncommitted, untracked or ignored files, or contains a retained nested worktree or Git repository. Ignored files and links have no cleanup ownership merely because Git ignores them; unknown artifacts remain pending. Owner checks inspect Linux processes associated with the factory user. Denied inspection of a possible same-user owner, unknown process identity, or an unsupported platform keeps cleanup pending. Nested ticket worktrees go before their parent, and branches go last by compare-and-delete. A stale heartbeat or a path-name prefix never allows a removal. Git keeps every commit reachable from main; there are no backups or archives.

`cleanup RUN_DIR` reconciles a run whose output was merged outside the factory. It never merges and deletes only after the same inclusion and ownership proof. Squash or rebase merges cannot be proved, so their work is retained.

### AFK on gl502

Each invocation can have its own transient systemd unit. This unit supervises one process; it does not dispatch other jobs. A unique unit name permits overlapping runs and survives SSH logout when user lingering is enabled:

```sh
unit="factory-$(date +%s)-$(cat /proc/sys/kernel/random/uuid)"
systemd-run --user --unit="$unit" --collect --property=UMask=0077 --property=KillMode=control-group \
  /home/berry/.local/bin/berry-afk run \
  --config /path/to/project.json --spec /path/to/approved-spec.md --flow build \
  --output /srv/appdata/berry/state/services/software-factory/runs
journalctl --user -u "$unit" -o cat
```

Use the printed run directory with `status` and `cancel`. Launching another unit starts another independent run immediately. Machine capacity and provider limits still apply; independence does not guarantee unchanged latency under load.

## Pipeline and gates

The planner derives observable acceptance and small tickets with an acyclic dependency graph. Ready tickets run concurrently within the configured limit. Each ticket gets a worktree and fresh implementer. Its dependencies integrate before downstream work. Integration is ordered inside that run. Unknown dependencies, duplicate IDs, malformed output and blockers stop execution.

Each review receives spec, standards, pinned baseline, source and check evidence. It receives no implementation conversation or earlier review. Repairs receive findings and check failures. Ticket review covers the assigned product scope; final review covers the combined product spec. Completion requires zero findings, passing checks and verified acceptance for every scoped criterion. Review-only can report findings as incomplete; it does not silently approve them.

Evidence includes source hashes, bounded check output and retained Git state. Read-only checks, planners and reviewers compare source plus HEAD, branch and staged index. Publication retains the exact accepted source and Git state. These checks detect observable changes; unrestricted host execution can still edit files. The pipeline has no push or deploy step and cannot attest unobserved historical external actions.

No source progress, repeated source, timeout, cancellation and round limits leave the run incomplete. An integration conflict also stops incomplete. Inspect retained work and resolve the cause before a new approved run. There is no automatic resume or lucky retry. A crash does not authorize completion.

## Runtime and verification

Runs use unique output branches/worktrees. Sandcastle's ignored metadata is shared per repository where required by its API; it does not control scheduling. Use `merge` or `cleanup` to remove a run's worktrees; do not remove retained worktrees or metadata used by another run. Source, configuration and mutable evidence have separate Berry locations. See [installation and migration](deploy/README.md).

Use Node 26, `npm ci`, `npm run typecheck` and `npm test` in this directory. Default tests use real Git/files and substitute model executables; they need no credentials. These tests verify control flow and process ownership. Live model behaviour needs a separate host check. Tool logs and captured Sandcastle sessions are disabled; provider CLIs can retain their own history. Check output redacts common secret patterns, but arbitrary output cannot be guaranteed secret-free.

The full native test suite requires Linux, `bwrap` (Bubblewrap), `flock`, and permission to create unprivileged user and PID namespaces. `npm test` runs the same Node test files inside a test-only namespace with a private `/proc`, all capabilities dropped, a read-only host filesystem, and writable temporary storage at a unique owned path. This keeps unrelated host processes from affecting cleanup ownership tests. It leaves the rest of `/tmp` visible so checkouts and dependencies stored there still work. The launcher uses two file workers to limit test pressure on shared hosts; concurrency within each test and test deadlines stay unchanged. The launcher removes its empty host temporary directory when it exits. To run selected files, use `node scripts/test.mjs test/delivery.test.ts`. This launcher does not change the factory runtime or its conservative cleanup checks.

## Sources

Ticket graphs and fresh implementation contexts follow [Matt Pocock's to-tickets](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-tickets) and [implement-spec](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement-spec). Review axes follow [code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review). [Sandcastle](https://github.com/mattpocock/sandcastle) supplies agent/worktree APIs. Berry supplies typed results, measured gates and independent run evidence.
