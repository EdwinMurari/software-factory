# Independent factory runs

Every `run` invocation executes the shared pipeline in its own process. There is no scheduler, pool, queue, API socket or resident service. Any coding agent can invoke the same CLI. Each worker call uses pinned Sandcastle 0.12.0 and a fresh Codex or Claude session with `noSandbox()`.

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

Runs use unique output branches/worktrees. Sandcastle's ignored metadata is shared per repository where required by its API; it does not control scheduling. Do not remove retained worktrees or metadata used by another run. Source, configuration and mutable evidence have separate Berry locations. See [installation and migration](deploy/README.md).

Use Node 26, `npm ci`, `npm run typecheck` and `npm test` in this directory. Default tests use real Git/files and substitute model executables; they need no credentials. These tests verify control flow and process ownership. Live model behaviour needs a separate host check. Tool logs and captured Sandcastle sessions are disabled; provider CLIs can retain their own history. Check output redacts common secret patterns, but arbitrary output cannot be guaranteed secret-free.

## Sources

Ticket graphs and fresh implementation contexts follow [Matt Pocock's to-tickets](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-tickets) and [implement-spec](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement-spec). Review axes follow [code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review). [Sandcastle](https://github.com/mattpocock/sandcastle) supplies agent/worktree APIs. Berry supplies typed results, measured gates and independent run evidence.
