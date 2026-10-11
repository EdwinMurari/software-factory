# Host installation

Install Node 26.5.0 and authenticated `codex` or `claude` CLIs for the `berry` account. Sandcastle 0.12.0 uses fresh agent sessions with `noSandbox()`. Workers have that account's host permissions. Agent calls and check commands have owned process groups. Cancellation or controller loss stops their descendants. Group cleanup failure is incomplete. Each agent also gets a private writable Git config layer, so Sandcastle setup does not lock or change another run’s global Git settings.

Deploy the verified, committed repository to `/srv/appdata/berry/projects/services/software-factory`, then run as `berry`:

```sh
cd /srv/appdata/berry/projects/services/software-factory/afk
bash deploy/install.sh
```

The installer creates a versioned release, with dependencies, under `/srv/appdata/berry/state/services/software-factory/releases/COMMIT/`. It atomically points `/home/berry/.local/bin/berry-afk` at that release. Existing processes retain their release paths when a newer version is installed. Keep releases used by active runs. The installer creates no service, socket or repository registry.

Copy [project.example.json](project.example.json) into an authorized project configuration directory and set actual paths, checks and worker settings. On Berry, use `/srv/appdata/berry/config/software-factory/PROJECT.json`. Explicitly select Codex or Claude and a model. Claude uses the owner-approved permission bypass; neither provider is sandboxed. Keep credentials in the provider's normal login storage, not in specs or command lines.

The installed wrapper supplies the Node and agent CLI PATH. For runs that survive logout, use the per-run transient unit example in the [run guide](../README.md). The host's `berry` account needs user lingering enabled. Each unit executes one independent pipeline; there is no central consumer.

## Retire a previous queue deployment

Do this once when replacing an old queue installation. Preserve live work and historical evidence. A new versioned release can run alongside a draining legacy job, provided its source is staged separately and the legacy checkout stays unchanged.

1. Inspect the old service's running and queued jobs. Let an active job reach a terminal state. Preserve queued specs/configs and record their disposition before starting them as independent runs. Never run the same job in both systems.
2. Once no old job needs the service, disable and stop `berry-afk.service`. Archive its unit/config/database and results under protected state. Remove the obsolete installed unit and API socket. Run `systemctl --user daemon-reload`. Historical database files are evidence, not an executable fallback.
3. Convert each needed registry entry to a separate project config using its original values. Retain historical registry data in the archive. The new CLI reads no registry.
4. Old `.sandcastle/worktrees`, `logs` and `patches` links can point into the former service state root. After old jobs stop, unlink only verified legacy links from each original repository. Preserve their targets and all worktrees. The new runtime prepares stable per-repository metadata. Foreign paths fail closed for operator review.
5. Install the new release. Verify two concurrent runs and cancellation independence before claiming migration complete.

Do not overwrite live source files used by the old process. Read-only database inspection can establish whether it is safe to stop; a stale earlier status cannot.

## Storage and boundaries

Canonical source stays under `/srv/appdata/berry/projects/services/software-factory`. Config files stay under `/srv/appdata/berry/config/software-factory`. Pass `--output /srv/appdata/berry/state/services/software-factory/runs` for durable run evidence. Default evidence and stable Sandcastle metadata live under the project's machine-local Git common directory. These are ignored operational files; never sync `.git`, generated metadata, dependencies, logs or releases through source sync.

The runtime prepares ignored `.sandcastle` metadata paths before worktree/agent calls. It preserves existing tracked Sandcastle configuration. It refuses unexpected metadata paths and worktrees it does not own. Dirty worktrees remain available for recovery. Cleanup is an explicit operator task, not an automatic completion step.

Sandcastle and its orchestration patterns are by Matt Pocock, under the MIT license. Berry owns the pipeline gates and run lifecycle.
