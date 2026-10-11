# Host runtime

The runtime pins [Sandcastle 0.12.0](https://www.npmjs.com/package/@ai-hero/sandcastle).
It uses the library's `run`, `noSandbox`, `createWorktree` and `Worktree.close` APIs.
It defaults to Codex with `gpt-6-astra` and high effort. A registered worker can use
`{"provider":"claude","model":"your-approved-model"}`. Set an explicit model.
Each call starts a fresh agent session. The parent runtime owns cancellation.
Each library call runs in a dedicated process group. Cancellation terminates the group,
including the host CLI and shell children, before the runtime returns. This closes the
pinned host provider's subprocess cleanup gap. Group cleanup failure is incomplete.
An idle timeout, nonzero agent exit, missing result tags or cancelled job is incomplete.
The service also applies the registered job timeout. Completion phrases cannot bypass
process exit. Sandcastle tool logs go to `/dev/null`; session capture is disabled.
Provider CLIs can retain their own local history. Returned results must not contain secrets.

This deployment runs agents on the host as `berry`, with the permissions of that user.
The user approved `noSandbox`. Socket access requires the `berry` user. Repository roots
and check commands come only from the operator's registration file.

On gl502, install Node 26.5.0 and authenticated `codex` or `claude` CLIs for `berry`.
Both agent CLIs must be on the unit's PATH. An operator must provision the protected configuration directory once:

```sh
sudo install -d -o berry -g berry -m 0700 /srv/appdata/berry/config/software-factory
```
 Deploy the verified repository to `/srv/appdata/berry/projects/services/software-factory`, then run as `berry` from its `afk` directory:

```sh
bash deploy/install.sh
/home/berry/.nvm/versions/node/v26.5.0/bin/node --version
$EDITOR /srv/appdata/berry/config/software-factory/repositories.json
systemctl --user enable --now berry-afk.service
systemctl --user status berry-afk.service
```

Canonical source stays in `/srv/appdata/berry/projects/services/software-factory`.
Configuration lives in `/srv/appdata/berry/config/software-factory`.
State lives in `/srv/appdata/berry/state/services/software-factory`, with dependencies
in its `runtime/` subdirectory. The source `afk/node_modules` link points there.
The installer preserves configuration and state and refuses to update an active unit.
Stop the unit before deploying source or updating dependencies. Optional provider settings
belong in `service.env` under the configuration directory, with mode 0600. Do not put
secrets in a spec, repository registration, or a command line. The host needs user
lingering enabled for `berry` so the service survives logout.

The installed `berry-afk` command forwards all arguments to the Unix socket CLI.
Use `ssh gl502 '/home/berry/.local/bin/berry-afk list'` to check the queue.
Registration changes take effect after a service restart. Wait until the queue has no running job before restarting, since recovery marks interrupted work incomplete. Stop the unit before updating source files.
Jobs active at a crash remain incomplete after restart. Inspect their retained worktrees
and submit a new job when appropriate. Successful branches and worktrees remain available.
The runtime refuses to remove worktrees it did not create and preserves dirty worktrees.

Before the first call, the runtime prepares `.sandcastle/worktrees`, `logs` and `patches`
as ignored links into the state directory. Each repository has its own path, keyed by
the SHA256 of its canonical root. Existing real directories or links to other targets
cause a failure. Review those paths before setup; the runtime does not migrate or delete
them. Existing tracked `.sandcastle` configuration stays in the source checkout. Local
Git excludes keep generated metadata out of checks and commits. The service supplies
`stateRoot` from its database directory. Add `.sandcastle` to the host's source sync
ignore list so generated metadata links do not sync to other devices.

Sandcastle and its orchestration patterns are by Matt Pocock, under the MIT license.
Berry adapts the execution and worktree APIs; it owns its queue and acceptance gates.
