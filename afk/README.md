# Berry AFK queue

This opt-in service runs approved specs without an interactive session. It uses pinned `@ai-hero/sandcastle` 0.12.0 for isolated worktrees and fresh Codex or Claude sessions with `noSandbox()`. Host execution is an explicit deployment choice. The default adapter is Codex `gpt-6-astra`; the service requires an explicit provider and model in each registered repository configuration.

Node 26 is required for `node:sqlite`. Install with `npm ci`, run `npm run typecheck` and `npm test` in `afk/`. Default tests need no model credentials. They use real SQLite, files and Git. The runtime fixture exercises the real Sandcastle package with a disposable fake executable. Live model evidence is a separate host check.

## Register and run

Only the local service account can change the protected configuration. The caller can select a repository ID, flow, immutable spec, idempotency key and comparison baseline. It cannot select a host path, command or model. The service pins check executables and existing absolute regular-file arguments when loading registration, then checks their hashes before and after each run. Evidence labels raw file bytes as `contentSha256`, which matches `sha256sum`. A separate `fingerprintSha256` includes decimal `lstat.mode`, symlink target and the content hash. Before/after values and the composite algorithm are recorded explicitly. Transitive dependencies, relative arguments and environment values outside the repository are not fingerprinted; register stable, credential-free checks. Registered checks are trusted executable paths with argument arrays; no shell evaluation is used. Never register untrusted commands. Keep the checkout clean; preserve and commit local changes before submission. Ignore `.sandcastle/worktrees/` and `.sandcastle/logs/` in registered repositories before use. Sandcastle runtime metadata must not enter the source fingerprint.

```json
{
  "socketPath": "/srv/appdata/berry/state/services/software-factory/api.sock",
  "databasePath": "/srv/appdata/berry/state/services/software-factory/queue.sqlite",
  "repositories": {
    "example": {
      "root": "/srv/appdata/example/source",
      "standards": "Use the repository AGENTS.md and preserve the approved scope.",
      "checks": [{"id":"test","command":"/home/berry/.nvm/versions/node/v26.5.0/bin/node","args":["--test"]}],
      "worker": {"provider":"codex","model":"gpt-6-astra"},
      "maxRounds": 4,
      "maxTickets": 12,
      "maxConcurrency": 2,
      "timeoutMs": 1200000
    }
  }
}
```

```sh
BERRY_AFK_CONFIG=/srv/appdata/berry/config/software-factory/repositories.json npm start
npm run cli -- --socket /srv/appdata/berry/state/services/software-factory/api.sock submit --repository example --flow build --spec /tmp/approved-spec.md --key change-2026-10-11
npm run cli -- --socket /srv/appdata/berry/state/services/software-factory/api.sock status JOB_ID
npm run cli -- --socket /srv/appdata/berry/state/services/software-factory/api.sock cancel JOB_ID
```

Any coding agent can invoke the same CLI through SSH. Copy the approved spec to the host, then run:

```sh
ssh berry@gl502 '/home/berry/.local/bin/berry-afk submit --repository example --flow build --spec /tmp/approved-spec.md --key unique-request-key'
```

For `review-repair` or `review-only`, add `--baseline FULL_40_CHARACTER_COMMIT_SHA`. The base must be an ancestor of current HEAD. Both flows inspect a retained isolated worktree. `review-only` dispatches no implementer or repairer. A reviewer or check source write causes an incomplete result. The original checkout never receives automatic merges or deployments. Successful output identifies a retained branch and worktree.

## Gates and recovery

The planner derives observable acceptance from the spec, then returns typed small tickets and an acyclic dependency graph. TDD guides implementation; historical process proof is not added to product acceptance. Unknown dependencies, duplicate IDs, malformed outputs and blockers stop work. Ready tickets can run concurrently; integration runs serially. Ticket review judges only its assigned product scope. Operating constraints are recorded separately for the controller. Final review judges the combined product spec and receives current original HEAD/source and output branch evidence. The controller has no push or deploy step. Host noSandbox execution cannot attest unobserved historical external agent actions. Each review is a fresh session with only spec, standards, pinned baseline, source and check evidence. It receives no implementation conversation or earlier review. Repairs receive actual findings and check failures. All scoped acceptance criteria need observed evidence; pending coverage prevents completion.

SQLite WAL transactions preserve immutable input/config snapshots, claims, cancellation, attempts and events. Check evidence records exact source hashes and bounded output. Source fingerprints include names, modes, bytes, symlink targets and deleted files. Read-only checks, planners and reviewers also compare retained Git HEAD, current branch and full staged index entries. Source or Git state changes invalidate the evidence. These checks detect observable retained state; noSandbox does not physically prevent writes or attest past actions. Repair progress still requires a source change; an empty commit does not count. Zero findings alone cannot override a failed check. Repeated source state, no source progress, timeout, cancellation and round budgets remain incomplete. Restart marks interrupted jobs incomplete and retains their prior evidence. There is no automatic lucky retry. To continue, inspect retained work, resolve the cause and submit a new approved request with a new key. Cancellation wins over late completion.

The socket and database use owner-only permissions. Runtime tool logs and captured sessions are disabled. Check output redacts common token/password patterns; use credential-free checks, since arbitrary program output cannot be guaranteed secret-free. Do not submit credentials in specs. Submission/status data belongs in protected state.

Deployment scripts are in [deploy/](deploy/). Source, configuration, mutable state and sockets have distinct Berry `/srv/appdata` locations. Retained worktrees and evidence are kept for inspection; cleanup is an operator action. No host setup or live execution occurs during default tests.

## Sources and adaptations

Ticket graphs and fresh implementation contexts follow [Matt Pocock's to-tickets](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-tickets) and [implement-spec](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement-spec). The two review axes follow [code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review). Agent/worktree execution uses [Sandcastle](https://github.com/mattpocock/sandcastle). These are structural patterns. This implementation uses a local durable queue, typed outputs and measured gates. It does not copy GitHub issue plumbing or text-based completion heuristics.
