"""Version 2: isolated deterministic batches and a read-only audit intake."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import uuid

from factory import (Controller, FactoryError, capture_baseline, digest, encoded, git,
                     identifier, keys, kill_group, now, positive, read_json, snapshot,
                     strings, text, validate_v1, validate_result, repository_lock_path)
from factory_audit import (INVESTIGATION_SCHEMA, audit_input, execution_intake,
                           investigation_result, reference, references_unchanged)


def repository_inputs(repositories):
    return {name: snapshot(path) for name, path in sorted(repositories.items())}


def controller_hash():
    return digest(encoded({name: digest(Path(__file__).with_name(name).read_bytes())
                           for name in ("factory.py", "factory_v2.py", "factory_audit.py", "factory_lifecycle.py")}))


def common_directory(project):
    value = os.fsdecode(git(project, "rev-parse", "--git-common-dir")).strip()
    return (project / value).resolve()


def lock_path(project):
    return repository_lock_path(project)


def load_plan(path, investigate=False):
    path = Path(path).resolve()
    raw = path.read_bytes()
    try:
        plan = json.loads(raw)
    except ValueError as exc:
        raise FactoryError(f"Cannot read JSON {path}: {exc}") from exc
    plan_hash = digest(raw)
    common = ["version", "repositories", "worker", "input"]
    optional = ["worker_timeout_seconds", "run_timeout_seconds", "max_workers", "pending_decisions"]
    build = ["checks", "tickets", "integration_checks", "spec", "decisions"]
    if investigate:
        keys(plan, common, optional)
    else:
        keys(plan, common + build, optional + ["max_attempts"])
    if type(plan["version"]) is not int or plan["version"] != 2:
        raise FactoryError("Expected plan version 2")
    if os.name != "posix":
        raise FactoryError("Version 2 requires POSIX and Git")
    if not isinstance(plan["repositories"], dict) or not plan["repositories"]:
        raise FactoryError("repositories must be a nonempty name-to-path object")
    repositories, common_dirs = {}, set()
    for name, value in sorted(plan["repositories"].items()):
        identifier(name)
        project = (path.parent / text(value, "repository path")).resolve()
        if Path(os.fsdecode(git(project, "rev-parse", "--show-toplevel")).strip()).resolve() != project:
            raise FactoryError("Every repository must be a Git worktree root")
        shared = common_directory(project)
        if shared in common_dirs or any(project == other or project in other.parents or other in project.parents
                                         for other in repositories.values()):
            raise FactoryError("Repositories must be distinct, nonnested Git repositories")
        repositories[name] = project
        common_dirs.add(shared)
    maximum = plan.get("max_workers", 2)
    if type(maximum) is not int or not 1 <= maximum <= 32:
        raise FactoryError("max_workers must be an integer from 1 to 32")
    # Reuse v1's worker, check, acceptance and graph validation, without making a second loop.
    if investigate:
        checks = [{"id": "validation", "argv": ["true"]}]
        tickets = [{"id": "validation", "prompt": "Read-only investigation", "depends_on": [],
                    "checks": ["validation"], "acceptance": [{"id": "coverage", "description": "All points covered"}]}]
    else:
        checks, tickets = [], []
        if not isinstance(plan["checks"], list) or not isinstance(plan["tickets"], list):
            raise FactoryError("checks and tickets must be lists")
        for check in plan["checks"]:
            keys(check, ["id", "argv", "repo"], ["timeout_seconds", "cache"])
            identifier(check["repo"])
            if check["repo"] not in repositories:
                raise FactoryError("Unknown check repository")
            checks.append({k: v for k, v in check.items() if k != "repo"})
        for ticket in plan["tickets"]:
            keys(ticket, ["id", "prompt", "depends_on", "checks", "acceptance", "repos", "decision_ids", "source"])
            names = strings(ticket["repos"], "ticket.repos", nonempty=True)
            if len(set(names)) != len(names) or set(names) - repositories.keys():
                raise FactoryError("Invalid task repository mapping")
            tickets.append({k: v for k, v in ticket.items() if k not in ("repos", "decision_ids", "source")})
    legacy = {"version": 1, "project": str(next(iter(repositories.values()))), "worker": plan["worker"],
              "checks": checks, "tickets": tickets,
              "integration_checks": ["validation"] if investigate else plan["integration_checks"]}
    legacy.update({k: plan[k] for k in ("max_attempts", "worker_timeout_seconds", "run_timeout_seconds", "pending_decisions") if k in plan})
    _, _, _, order = validate_v1(legacy, path, plan_hash)
    sources = repository_inputs(repositories)
    plan["_source_inputs"] = sources
    plan["_source_branches"] = {name: os.fsdecode(git(root, "rev-parse", "--abbrev-ref", "HEAD")).strip()
                                for name, root in repositories.items()}
    if not isinstance(plan["input"], dict):
        raise FactoryError("input must be an object")
    dependencies = []
    if investigate:
        points, groups = audit_input(plan["input"], path.parent, dependencies)
        plan["_audit"] = {"points": points, "groups": groups}
    else:
        plan["spec"] = reference(plan["spec"], path.parent)
        dependencies.append(plan["spec"])
        check_map = {c["id"]: c for c in plan["checks"]}
        for ticket in plan["tickets"]:
            ticket["source"] = reference(ticket["source"], path.parent)
            dependencies.append(ticket["source"])
            if any(check_map[cid]["repo"] not in ticket["repos"] for cid in ticket["checks"]):
                raise FactoryError("Task checks must target participating repositories")
        # Every repository's commands must be included in the final exact-state check set.
        final_ids = set(plan["integration_checks"]) | {c for t in plan["tickets"] for c in t["checks"]}
        if {check_map[c]["repo"] for c in final_ids} != repositories.keys():
            raise FactoryError("Final checks must cover every participating repository")
        plan["_repositories"] = repositories
        plan["_intake"] = execution_intake(plan, path.parent, sources, {t["id"]: t for t in plan["tickets"]}, dependencies)
        del plan["_repositories"]
    plan["_dependencies"] = dependencies
    return plan, repositories, plan_hash, order


class Runtime:
    """One deadline, cancellation flag and active process registry for the run."""
    def __init__(self, deadline):
        self.deadline = deadline
        self.cancelled = threading.Event()
        self.mutex = threading.Lock()
        self.git_mutex = threading.Lock()
        self.active = set()

    def stop(self):
        self.cancelled.set()
        with self.mutex:
            processes = list(self.active)
        for proc in processes:
            kill_group(proc)


class Session(Controller):
    """Reuse the v1 implement/check/repair/review engine inside one task's worktrees."""
    def __init__(self, owner, repositories, output, tickets, baseline):
        self.owner, self.runtime = owner, owner.runtime
        self.repositories = repositories
        self.project = next(iter(repositories.values()))
        self.plan_path, self.plan_hash = owner.plan_path, owner.plan_hash
        self.plan = dict(owner.plan, tickets=tickets)
        self.output = output
        output.mkdir(parents=True, exist_ok=True)
        self.deadline = self.runtime.deadline
        self.checks = {c["id"]: c for c in self.plan.get("checks", [])}
        self.tickets = {t["id"]: t for t in tickets}
        self.order = list(self.tickets)
        self.sequence, self.cache = 0, {}
        self.report = {"tickets": {tid: {"status": "pending", "attempts": []} for tid in self.order},
                       "processes": [], "baseline": baseline, "final_checks": [], "final_review": None}

    def save(self):
        if "observed_inputs" not in self.report:
            self.report["observed_inputs"] = repository_inputs(self.repositories)
        super().save()

    def restore(self):
        path = self.output / "report.json"
        if path.exists():
            self.report = read_json(path)
            self.sequence = len(self.report["processes"])
        return self

    def adapter_directories(self):
        return [p for p in self.repositories.values() if p != self.project]

    def inputs(self):
        return digest(encoded(repository_inputs(self.repositories)))

    def progress(self):
        # Commits change HEAD even when a repair cycles back to earlier content.
        return digest(encoded({name: os.fsdecode(git(path, "rev-parse", "HEAD^{tree}")).strip()
                               for name, path in sorted(self.repositories.items())}))

    def plan_unchanged(self):
        self.owner.unchanged()

    def execute(self, argv, label, timeout, stdin=b"", readonly=False, cwd=None):
        self.plan_unchanged()
        if self.runtime.cancelled.is_set():
            raise FactoryError("Run cancelled")
        before_inputs = repository_inputs(self.repositories)
        before = digest(encoded(before_inputs))
        self.report["observed_inputs"] = before_inputs
        available = min(timeout, self.deadline - time.monotonic())
        if available <= 0:
            raise FactoryError("Run wall-clock budget exhausted")
        self.sequence += 1
        stem = f"{self.sequence:03d}-{label}"
        out, err = self.output / (stem + ".stdout"), self.output / (stem + ".stderr")
        record = {"argv": argv, "phase": label, "stdout": str(out), "stderr": str(err),
                  "inputs_sha256": before, "repository_inputs": before_inputs,
                  "started_at_aest": now(), "status": "incomplete", "cwd": str(cwd or self.project)}
        self.report["processes"].append(record)
        self.save()
        proc = None
        try:
            with out.open("wb") as stdout, err.open("wb") as stderr:
                # Registration and cancellation share a mutex: cancellation cannot miss a new process.
                with self.runtime.mutex:
                    if self.runtime.cancelled.is_set():
                        raise FactoryError("Run cancelled")
                    proc = subprocess.Popen(argv, cwd=cwd or self.project, stdin=subprocess.PIPE,
                                            stdout=stdout, stderr=stderr, start_new_session=True)
                    self.runtime.active.add(proc)
                    record["pid"] = proc.pid
                    self.save()
                end = time.monotonic() + available
                first = True
                while True:
                    try:
                        proc.communicate(input=stdin if first else None, timeout=min(0.2, max(0.001, end - time.monotonic())))
                        record["exit_code"] = proc.returncode
                        record["status"] = "passed" if proc.returncode == 0 else "failed"
                        break
                    except subprocess.TimeoutExpired:
                        first = False
                        if self.runtime.cancelled.is_set() or time.monotonic() >= end:
                            record["status"] = "cancelled" if self.runtime.cancelled.is_set() else "timeout"
                            kill_group(proc)
                            record["exit_code"] = proc.returncode
                            break
        except OSError as exc:
            record["error"] = str(exc)
        finally:
            if proc is not None:
                kill_group(proc)
                with self.runtime.mutex:
                    self.runtime.active.discard(proc)
            record["finished_at_aest"] = now()
            self.report["observed_inputs"] = repository_inputs(self.repositories)
            record["after_inputs_sha256"] = digest(encoded(self.report["observed_inputs"]))
            if readonly and before != record["after_inputs_sha256"]:
                record["status"] = "source_changed"
            self.save()
        self.plan_unchanged()
        return record

    def run_checks(self, ids):
        results = []
        for cid in dict.fromkeys(ids):
            check = self.checks[cid]
            result = dict(self.execute(check["argv"], "check-" + cid, check.get("timeout_seconds", 120),
                                       readonly=True, cwd=self.repositories[check["repo"]]),
                          check_id=cid, repo=check["repo"], reused=False)
            results.append(result)
            if result["status"] != "passed":
                break
        return results

    def worker_context(self, phase, ticket):
        return {"repositories": {name: str(path) for name, path in self.repositories.items()},
                "spec": self.plan.get("spec"), "decisions": self.plan.get("decisions", []),
                "intake": self.plan.get("_intake"),
                "integration_heads": {name: os.fsdecode(git(path, "rev-parse", "HEAD")).strip()
                                      for name, path in self.repositories.items()},
                "merger_instructions": "For merger phase, resolve the reported conflicts within the approved task and stage each resolved path. Leave commits and merges to the program. Report blocked if the conflict needs a new product choice.",
                "scope": "Only participating worktrees. Program controls commits and merges. No push, deployment or issue closing."}

    def worker(self, phase, ticket, evidence):
        heads = {name: git(path, "rev-parse", "HEAD", "--abbrev-ref", "HEAD") for name, path in self.repositories.items()}
        result = super().worker(phase, ticket, evidence)
        if any(git(path, "rev-parse", "HEAD", "--abbrev-ref", "HEAD") != heads[name] for name, path in self.repositories.items()):
            raise FactoryError("Worker changed Git HEAD; program controls commits and merges")
        if "review" not in phase and result["status"] != "blocked":
            if phase == "merger" and any(git(path, "ls-files", "-u") for path in self.repositories.values()):
                raise FactoryError("Conflict repair left unresolved Git entries; resolve and stage each conflict")
            self.commit_all(f"Factory {phase}: " + (ticket["id"] if ticket else "integration"))
        return result

    def git_operation(self, path, *args, allow_failure=False):
        argv = ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Software Factory",
                "-c", "user.email=software-factory@localhost", "-c", "commit.gpgSign=false",
                "-c", "merge.gpgSign=false", "-c", "rerere.enabled=false", "-C", str(path), *args]
        with self.runtime.git_mutex:
            record = self.execute(argv, "git-" + args[0], 30)
        if record["status"] != "passed" and not (allow_failure and record["status"] == "failed"):
            raise FactoryError(f"Git {args[0]} {record['status']}; inspect preserved logs")
        return record

    def commit_all(self, message):
        for path in self.repositories.values():
            merge_head = Path(os.fsdecode(git(path, "rev-parse", "--git-path", "MERGE_HEAD")).strip())
            if not merge_head.is_absolute():
                merge_head = path / merge_head
            if git(path, "status", "--porcelain") or merge_head.exists():
                self.git_operation(path, "add", "-A")
                self.git_operation(path, "commit", "-m", message)


class ControllerV2:
    def __init__(self, plan_path, output_dir=None, investigate=False, resume=False):
        self.plan_path = Path(plan_path).resolve()
        self.plan, self.sources, self.plan_hash, self.order = load_plan(self.plan_path, investigate)
        self.investigate = investigate
        self.output = Path(output_dir).resolve() if output_dir else Path(tempfile.mkdtemp(prefix="software-factory-v2-"))
        if any(self.output == p or p in self.output.parents for p in self.sources.values()):
            raise FactoryError("Output must be outside every source worktree")
        if any(self.output == Path(ref["path"]) or self.output in Path(ref["path"]).parents
               for ref in self.plan["_dependencies"] + [{"path": str(self.plan_path)}]):
            raise FactoryError("Output must not contain plan or evidence dependencies")
        self.output.mkdir(parents=True, exist_ok=True)
        if not resume and any(self.output.iterdir()):
            raise FactoryError("Output directory must be empty")
        self.runtime = Runtime(time.monotonic() + self.plan.get("run_timeout_seconds", 7200))
        self.source_inputs = self.plan["_source_inputs"]
        self.source_branches = self.plan["_source_branches"]
        self.code_hash = controller_hash()
        self.run_id = uuid.uuid4().hex
        self.locks, self.integration, self.sessions = [], {}, {}
        self.resuming = resume
        self.acquired = False
        self.operation_ready = False
        self.report = {"version": 2, "run_id": self.run_id, "mode": "investigate" if investigate else "build", "status": "incomplete",
                       "started_at_aest": now(), "plan_path": str(self.plan_path), "plan_sha256": self.plan_hash,
                       "controller_sha256": self.code_hash, "source_inputs": self.source_inputs,
                       "source_repositories": {n: str(p) for n, p in self.sources.items()},
                       "dependencies": self.plan["_dependencies"], "source_branches": self.source_branches, "repositories": {},
                       "tickets": {tid: {"status": "pending", "depends_on": t["depends_on"], "attempts": []}
                                   for t in self.plan.get("tickets", []) for tid in [t["id"]]},
                       "batches": [], "integration_order": [], "final_checks": [], "final_review": None,
                       "claim": "Checks and fresh structured evidence; not authentication, bug freedom or product approval."}
        if investigate:
            value = self.plan["input"]
            self.report.update(audit_points=value["points"], audit_sha256=digest(encoded({"points": value["points"], "groups": value.get("groups", [])})),
                               points=[], investigations=[])
        else:
            self.report["intake"] = self.plan["_intake"]
        if resume:
            self.report = read_json(self.output / "report.json")
            self.run_id = self.report["run_id"]
            self.plan_hash = self.report["plan_sha256"]
            self.code_hash = self.report["controller_sha256"]
            self.source_inputs = self.report["source_inputs"]
            self.source_branches = self.report["source_branches"]
            self.integration = {n: Path(r["worktree"]) for n, r in self.report["repositories"].items()}


    def save(self):
        target = self.output / "report.json"
        temporary = self.output / "report.json.tmp"
        temporary.write_bytes(encoded(self.report))
        temporary.replace(target)

    def unchanged(self):
        if digest(self.plan_path.read_bytes()) != self.plan_hash:
            raise FactoryError("Plan changed during run")
        if controller_hash() != self.code_hash:
            raise FactoryError("Controller changed during run")
        references_unchanged(self.plan["_dependencies"])
        if (repository_inputs(self.sources) != self.source_inputs
                or {n: os.fsdecode(git(p, "rev-parse", "--abbrev-ref", "HEAD")).strip() for n, p in self.sources.items()} != self.source_branches):
            raise FactoryError("Starting source checkout changed; evidence invalid")

    def acquire(self):
        for path in [self.output / ".operation.lock", *sorted({lock_path(p) for p in self.sources.values()})]:
            # Advisory lock file remains stable. Unlinking it creates a race with waiting openers.
            stream = path.open("a+b")
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                stream.close()
                raise FactoryError(f"Another factory run holds repository lock: {path}") from exc
            self.locks.append(stream)
        self.unchanged()
        from factory_lifecycle import claim_run
        if not self.investigate:
            claim_run(self)
        self.acquired = True

    def baseline(self, repositories, directory):
        records = {}
        for name, path in repositories.items():
            target = directory / name
            target.mkdir(parents=True, exist_ok=True)
            records[name] = capture_baseline(path, target)
        return records

    def worktree(self, name, source, role, base):
        self.unchanged()
        if self.runtime.cancelled.is_set() or time.monotonic() >= self.runtime.deadline:
            raise FactoryError("Cancelled or run wall-clock budget exhausted")
        branch = f"factory/{self.run_id}/{role}/{name}"
        path = self.output / "worktrees" / role / name
        path.parent.mkdir(parents=True, exist_ok=True)
        for setup in self.report.get("worktree_setups", []):
            if setup["repo"] == name and setup["role"] == role and path.exists():
                if os.fsdecode(git(path, "rev-parse", "--abbrev-ref", "HEAD")).strip() != branch:
                    raise FactoryError("Retained worktree branch changed")
                return path, {key: setup[key] for key in ("branch", "worktree", "base_sha")}
        # All mutations occur on the coordinator thread, except isolated task commits.
        helper = Session(self, {name: source}, self.output / "setup" / role / name, [], {})
        record = {"branch": branch, "worktree": str(path), "base_sha": base}
        setup = {"repo": name, "role": role, **record, "status": "pending", "report": str(helper.output / "report.json")}
        self.report.setdefault("worktree_setups", []).append(setup)
        self.save()
        try:
            helper.git_operation(source, "worktree", "add", "-b", branch, str(path), base)
            setup["status"] = "created"
        except (FactoryError, OSError):
            setup["status"] = "incomplete"
            raise
        finally:
            self.save()
        return path, record

    def prepare(self):
        for name, source in self.sources.items():
            if git(source, "status", "--porcelain", "--untracked-files=all"):
                raise FactoryError(f"Dirty source repository {name}: preserve or commit its changes before isolated build; investigation accepts working changes")
        for name, source in self.sources.items():
            if name in self.integration:
                continue
            base = os.fsdecode(git(source, "rev-parse", "HEAD")).strip()
            path, record = self.worktree(name, source, "integration", base)
            self.integration[name] = path
            self.report["repositories"][name] = record
            self.save()

    def task_session(self, ticket):
        repositories, records = {}, {}
        existing = self.report["tickets"][ticket["id"]].get("repositories")
        if existing:
            repositories = {n: Path(r["worktree"]) for n, r in existing.items()}
            output = self.output / "tasks" / ticket["id"]
            previous = read_json(output / "report.json")
            return Session(self, repositories, output, [ticket], previous["baseline"]).restore()
        for name in sorted(ticket["repos"]):
            base = os.fsdecode(git(self.integration[name], "rev-parse", "HEAD")).strip()
            path, record = self.worktree(name, self.sources[name], "task-" + ticket["id"], base)
            repositories[name], records[name] = path, record
        output = self.output / "tasks" / ticket["id"]
        output.mkdir(parents=True)
        session = Session(self, repositories, output, [ticket], self.baseline(repositories, output))
        self.report["tickets"][ticket["id"]]["repositories"] = records
        session.save()
        self.save()
        return session

    def run_task(self, ticket, session):
        try:
            session.run_ticket(ticket, resume=self.resuming)
            return None
        except (FactoryError, OSError) as exc:
            return str(exc)

    def integrate(self, ticket, session):
        tid = ticket["id"]
        # All integration is serialized in stable batch order. Bring integration into
        # each task before acceptance; every repo lands before dependencies become ready.
        for name, path in session.repositories.items():
            current = os.fsdecode(git(self.integration[name], "rev-parse", "HEAD")).strip()
            record = session.git_operation(path, "merge", "--no-edit", current, allow_failure=True)
            if record["status"] == "failed":
                conflicts = os.fsdecode(git(path, "diff", "--name-only", "--diff-filter=U")).splitlines()
                if not conflicts:
                    raise FactoryError("Git merge failed without resolvable conflicts")
                result = session.worker("merger", ticket, [{"repository": name, "conflicts": conflicts,
                                                            **session.failure_evidence([record])[0]}])
                if result["status"] == "blocked":
                    raise FactoryError("Conflict repair blocked: " + result["summary"])
                if git(path, "ls-files", "-u"):
                    raise FactoryError("Conflict repair left unresolved Git entries")
        # The shared final loop rechecks every task criterion against the committed
        # merged source. No evidence is relabelled after a commit or merge.
        session.plan["integration_checks"] = ticket["checks"]
        session.verify_integration()
        checked = session.inputs()
        if any(c["inputs_sha256"] != checked for c in session.report["final_checks"]):
            raise FactoryError("Task integration check evidence is stale")
        for name, path in session.repositories.items():
            commit = os.fsdecode(git(path, "rev-parse", "HEAD")).strip()
            session.git_operation(self.integration[name], "merge", "--ff-only", commit)
            self.report["repositories"][name]["head"] = commit
        self.report["tickets"][tid]["status"] = "integrated"
        self.report["integration_order"].append(tid)
        self.save()

    def build(self):
        intake = self.plan["_intake"]
        if intake["global_blockers"]:
            raise FactoryError("; ".join(intake["global_blockers"]))
        for tid, reasons in intake["task_blockers"].items():
            if reasons:
                self.report["tickets"][tid].update(status="not_run", reason="; ".join(reasons))
        self.prepare()
        tickets = {t["id"]: t for t in self.plan["tickets"]}
        remaining = {tid for tid in tickets if not intake["task_blockers"].get(tid)
                     and self.report["tickets"][tid]["status"] != "integrated"}
        while remaining:
            ready = sorted(tid for tid in remaining if all(self.report["tickets"][d]["status"] == "integrated"
                                                         for d in tickets[tid]["depends_on"]))
            if not ready:
                for tid in remaining:
                    self.report["tickets"][tid].update(status="not_run", reason="Incomplete dependencies")
                break
            batch = ready[:self.plan.get("max_workers", 2)]
            self.report["batches"].append(batch)
            for tid in batch:
                self.sessions[tid] = self.task_session(tickets[tid])
            self.save()
            pool = ThreadPoolExecutor(max_workers=len(batch))
            try:
                futures = {tid: pool.submit(self.run_task, tickets[tid], self.sessions[tid]) for tid in batch}
                # Waiting in stable order does not serialize the subprocesses.
                errors = {tid: future.result() for tid, future in futures.items()}
            except BaseException:
                self.runtime.stop()
                raise
            finally:
                pool.shutdown(wait=True, cancel_futures=True)
            for tid in batch:
                session = self.sessions[tid]
                state = self.report["tickets"][tid]
                state.update(attempts=session.report["tickets"][tid]["attempts"],
                             processes=session.report["processes"], report=str(session.output / "report.json"))
                if errors[tid]:
                    state.update(status="incomplete", reason=errors[tid])
                else:
                    try:
                        self.integrate(tickets[tid], session)
                    except (FactoryError, OSError) as exc:
                        state.update(status="incomplete", reason=str(exc))
                state["integration_evidence"] = {k: session.report.get(k) for k in ("integration_attempts", "final_checks", "final_review")}
                remaining.remove(tid)
                self.save()
        failures = [f"{tid}: {state.get('reason', state['status'])}" for tid, state in self.report["tickets"].items()
                    if state["status"] != "integrated"]
        if failures or intake["blockers"]:
            raise FactoryError("Task incomplete: " + "; ".join(intake["blockers"] + failures))
        final_output = self.output / "final"
        final_output.mkdir(exist_ok=True)
        # Review from original baselines, not task histories or intermediate conclusions.
        saved_final = final_output / "report.json"
        baseline = (read_json(saved_final)["baseline"] if saved_final.exists()
                    else self.baseline(self.sources, self.output / "original-baselines"))
        final = Session(self, self.integration, final_output, self.plan["tickets"], baseline).restore()
        self.final_session = final
        pending = [item for item in self.report.get("findings", []) if not item.get("resolved")]
        if pending:
            repair = final.worker("integration_repair", None, pending)
            if repair["status"] == "blocked":
                raise FactoryError("Late finding repair blocked: " + repair["summary"])
        final.verify_integration()
        for item in pending:
            item["resolved"] = True
        self.unchanged()
        exact = repository_inputs(self.integration)
        fingerprint = digest(encoded(exact))
        if any(c["inputs_sha256"] != fingerprint for c in final.report["final_checks"]):
            raise FactoryError("Final integration evidence stale")
        self.report.update(final_inputs=exact, final_checks=final.report["final_checks"], final_review=final.report["final_review"],
                           integration_attempts=final.report["integration_attempts"], final_processes=final.report["processes"], status="verified")
        for name, path in self.integration.items():
            self.report["repositories"][name]["head"] = os.fsdecode(git(path, "rev-parse", "HEAD")).strip()

    def investigate_points(self):
        audit = self.plan["_audit"]
        # Read-only workers get current source including working edits, each in a fresh process.
        questions = set()
        for group in audit["groups"]:
            output = self.output / "investigations" / group["id"]
            output.mkdir(parents=True)
            session = Session(self, self.sources, output, [], self.baseline(self.sources, output))
            record = {"group": group, "report": str(output / "report.json"), "processes": session.report["processes"]}
            self.report["investigations"].append(record)
            self.save()
            request = {"phase": "investigate", "project": str(session.project),
                       "repositories": {n: str(p) for n, p in self.sources.items()},
                       "points": [audit["points"][pid] for pid in group["point_ids"]], "group": group,
                       "baseline": session.report["baseline"], "result_schema": INVESTIGATION_SCHEMA,
                       "instructions": "Investigate read-only in this fresh session. Account for every supplied point using actual source evidence. Return confirmed, disproved or blocked, and product questions. Findings never approve implementation or deferral. Use installed ask-matt to select existing skills; do not copy a routing catalogue. Do not edit source, plan, controller, reports or logs. Do not commit, push, deploy or close issues."}
            result = session.invoke(request, "investigate", INVESTIGATION_SCHEMA,
                                    lambda v: investigation_result(v, group["point_ids"]), readonly=True)
            for point in result["points"]:
                for question in point["questions"]:
                    if question["id"] in questions:
                        raise FactoryError("Product question IDs must be unique across investigations")
                    questions.add(question["id"])
            record["result"] = result
            self.report["points"].extend(result["points"])
            self.save()
        self.unchanged()
        self.report["status"] = "investigated"

    def run(self, action="continue", reason=None, findings=None):
        try:
            self.acquire()
            from factory_lifecycle import prepare_operation
            prepare_operation(self, action, reason, findings)
            self.operation_ready = True
            if action == "register":
                self.report["status"] = "registered"
                return self.report
            if self.investigate:
                self.investigate_points()
            else:
                self.build()
        except (FactoryError, OSError, KeyboardInterrupt) as exc:
            self.report.update(status="incomplete", reason=str(exc) or "Interrupted")
        finally:
            self.runtime.stop()
            # A rejected concurrent opener must not overwrite the active run's report.
            if self.acquired and self.operation_ready:
                self.finalize()
            else:
                for stream in self.locks:
                    stream.close()
                if not self.resuming and not (self.output / "report.json").exists():
                    self.save()
        return self.report

    def finalize(self):
        # Preserve all started work and partial Git operations. Nothing is reset or cleaned.
        for tid, session in self.sessions.items():
            state = self.report["tickets"][tid]
            state.update(attempts=session.report["tickets"][tid]["attempts"], processes=session.report["processes"])
        if hasattr(self, "final_session"):
            self.report["final_processes"] = self.final_session.report["processes"]
        for state in self.report["tickets"].values():
            if state["status"] == "pending":
                state["status"] = "not_run"
        try:
            self.unchanged()
            if self.report["status"] == "verified" and repository_inputs(self.integration) != self.report["final_inputs"]:
                raise FactoryError("Source changed during finalization; evidence stale")
        except (FactoryError, OSError) as exc:
            self.report.update(status="incomplete", reason=str(exc))
        self.report["observed_worktree_inputs"] = {}
        try:
            from factory_lifecycle import known_worktrees
            for path in known_worktrees(self.report):
                self.report["observed_worktree_inputs"][path] = snapshot(Path(path))
            self.report["evidence_files"] = [
                {"path": str(path), "sha256": digest(path.read_bytes())}
                for directory in ("tasks", "final", "investigations", "setup", "original-baselines", "adoptions", "history")
                for path in sorted((self.output / directory).rglob("*")) if path.is_file()]
        except (FactoryError, OSError) as exc:
            self.report.update(status="incomplete", reason=str(exc))
        self.report["operation_open"] = False
        self.report["finished_at_aest"] = now()
        try:
            self.save()
            from factory_lifecycle import complete, finish_claim
            if self.report["status"] == "verified":
                try:
                    complete(self.output / "report.json")
                except (FactoryError, OSError, KeyError, TypeError, ValueError) as exc:
                    self.report.update(status="incomplete", reason="Completion gate: " + str(exc))
                    self.save()
            finish_claim(self)
        finally:
            for stream in self.locks:
                fcntl.flock(stream, fcntl.LOCK_UN)
                stream.close()


def report_status(path):
    report = read_json(path)
    if report.get("mode") == "build" and report.get("status") == "verified":
        from factory_lifecycle import complete
        try:
            return complete(path)
        except (FactoryError, OSError, KeyError, TypeError, ValueError) as exc:
            return {"status": "stale", "fresh": False, "report": str(Path(path).resolve()), "reason": str(exc)}
    if report.get("status") == "closed":
        return {"status": "closed", "verified": False, "report": str(Path(path).resolve()), "closure": report["closure"]}
    fresh = False
    try:
        fresh = (digest(Path(report["plan_path"]).read_bytes()) == report["plan_sha256"]
                 and controller_hash() == report["controller_sha256"]
                 and repository_inputs({n: Path(p) for n, p in report["source_repositories"].items()}) == report["source_inputs"])
        references_unchanged(report["dependencies"] + report.get("evidence_files", []))
        fresh = fresh and all(snapshot(Path(p)) == value for p, value in report.get("observed_worktree_inputs", {}).items())
        fresh = fresh and {n: os.fsdecode(git(Path(p), "rev-parse", "--abbrev-ref", "HEAD")).strip()
                           for n, p in report["source_repositories"].items()} == report["source_branches"]
        if report["mode"] == "build" and report["status"] == "verified":
            fresh = fresh and repository_inputs({n: Path(r["worktree"]) for n, r in report["repositories"].items()}) == report["final_inputs"]
    except (FactoryError, OSError, KeyError):
        fresh = False
    return {"status": report["status"] if fresh else "stale", "fresh": fresh,
            "report": str(Path(path).resolve()), "claim": report["claim"]}
