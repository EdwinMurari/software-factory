#!/usr/bin/env python3
"""Behavior tests use disposable Git repositories and fake, cost-free workers."""
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import factory


FAKE = r'''
import json, os, pathlib, subprocess, sys, time
kind = pathlib.Path(sys.argv[0]).name
if kind in ("codex", "claude"):
    mode, control_path = "worker", os.environ["FACTORY_TEST_CONTROL"]
else:
    mode, control_path = sys.argv[1:3]
control = json.loads(pathlib.Path(control_path).read_text())
base = pathlib.Path(control_path).parent
def log(value):
    with (base / "calls.jsonl").open("a") as f: f.write(json.dumps(value) + "\n")
if mode == "check":
    log({"phase": "check"})
    if control.get("check_mutates"):
        pathlib.Path("changed-by-check").write_text("changed")
    if control.get("check_timeout"):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        (base / "child.pid").write_text(str(child.pid))
        time.sleep(60)
    if control.get("runtime_fixture"):
        sys.exit(0 if (base / "runtime").read_text() == "good" else 9)
    if control.get("check_fails") or (control.get("repair_needed") and not pathlib.Path("repaired").exists()):
        print("specific failure: expected persisted record")
        print("error detail retained", file=sys.stderr)
        sys.exit(7)
    print("behavior verified")
    sys.exit(0)
request = json.load(sys.stdin)
phase = request["phase"]
log({"phase": phase, "request": request, "argv": sys.argv, "pid": os.getpid()})
if control.get("worker_timeout"):
    (base / "worker.pid").write_text(str(os.getpid()))
    time.sleep(60)
if control.get("rewrite_plan"):
    pathlib.Path(control["rewrite_plan"]).write_text("{}")
if phase in ("implement", "repair", "integration_repair"):
    if phase == "implement":
        pathlib.Path(request["ticket"]["id"] + ".txt").write_text("implemented")
    elif not control.get("no_progress"):
        target = pathlib.Path("repaired" if phase == "repair" else "integrated")
        target.write_text(str(int(target.read_text()) + 1) if target.exists() else "1")
if "review" in phase and control.get("review_mutates"):
    pathlib.Path("changed-by-review").write_text("changed")
if "review" in phase and control.get("malformed_review"):
    print("I reviewed it and it looks fine")
    sys.exit(0)
result = {"status": "complete", "summary": "Checked requested behavior", "issues": [],
          "acceptance": [{"id": c["id"], "status": "verified", "evidence": "Observed behavior and preserved check logs"}
                         for c in request["acceptance"]]}
if control.get("blocked"):
    result["status"] = "blocked"
    result["summary"] = "Permission required"
if "review" in phase and control.get("missing_criterion"):
    result["acceptance"] = []
if "review" in phase and control.get("pending"):
    result["acceptance"][0]["status"] = "pending"
if phase == "final_review" and control.get("integration_defect") and not pathlib.Path("integrated").exists():
    result["status"] = "changes_requested"
    result["issues"] = ["Tickets conflict when used together"]
if "review" in phase:
    target = pathlib.Path("integrated" if phase == "final_review" else "repaired")
    needed = control.get("integration_rounds" if phase == "final_review" else "ticket_rounds", 0)
    completed = int(target.read_text()) if target.exists() else 0
    if completed < needed:
        result["status"] = "changes_requested"
        result["issues"] = ["Remaining defect " + str(completed + 1)]
if kind == "codex":
    target = sys.argv[sys.argv.index("--output-last-message") + 1]
    pathlib.Path(target).write_text(json.dumps(result))
    print(json.dumps({"type": "turn.completed"}))
elif kind == "claude":
    print(json.dumps({"is_error": False, "structured_output": result}))
else:
    print(json.dumps(result))
'''


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="factory-tests-")
        self.base = Path(self.temporary.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "factory-test@example.invalid")
        self.git("config", "user.name", "Factory Test")
        (self.repo / "existing.txt").write_text("baseline\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.fake = self.base / "fake.py"
        self.fake.write_text(FAKE)
        self.control = self.base / "control.json"
        self.control.write_text("{}")
        self.plan_path = self.base / "plan.json"
        self.plan = {
            "version": 1, "project": str(self.repo),
            "worker": {"kind": "custom", "argv": [sys.executable, str(self.fake), "worker", str(self.control)]},
            "checks": [{"id": "behavior", "argv": [sys.executable, str(self.fake), "check", str(self.control)],
                        "timeout_seconds": 5, "cache": True}],
            "tickets": [self.ticket("a")], "integration_checks": ["behavior"],
            "max_attempts": 2, "worker_timeout_seconds": 5, "run_timeout_seconds": 30,
        }

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True).stdout

    def ticket(self, tid, dependencies=()):
        return {"id": tid, "prompt": "Implement persisted task behavior", "depends_on": list(dependencies),
                "checks": ["behavior"], "acceptance": [{"id": tid + "-persists", "description": "Task survives refresh"}]}

    def configure(self, **values):
        self.control.write_text(json.dumps(values))

    def save_plan(self):
        self.plan_path.write_text(json.dumps(self.plan))

    def controller(self):
        self.save_plan()
        return factory.Controller(self.plan_path, self.base / "output")

    def run_factory(self):
        controller = self.controller()
        report = controller.run()
        return controller, report

    def calls(self):
        path = self.base / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_valid_run_reviews_independently_and_reuses_source_only_check(self):
        controller, report = self.run_factory()
        self.assertEqual(report["status"], "verified", report.get("reason"))
        self.assertEqual([c["phase"] for c in self.calls()], ["implement", "check", "review", "final_review"])
        self.assertTrue(report["final_checks"][0]["reused"])
        self.assertEqual(factory.report_status(controller.output / "report.json")["status"], "verified")

    def test_default_loop_repairs_until_ticket_and_integration_reviews_are_clear(self):
        self.plan.pop("max_attempts")
        self.configure(ticket_rounds=3, integration_rounds=3)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "verified", report.get("reason"))
        self.assertEqual(len(report["tickets"]["a"]["attempts"]), 4)
        self.assertEqual(len(report["integration_attempts"]), 4)
        self.assertEqual(report["final_review"]["issues"], [])
        calls = [c for c in self.calls() if c["phase"] != "check"]
        self.assertEqual(len({c["pid"] for c in calls}), len(calls))
        for call in calls:
            if "review" in call["phase"]:
                self.assertTrue(all("check_id" in item for item in call["request"]["evidence"]))
                self.assertNotIn("Remaining defect", json.dumps(call["request"]))
        repair = next(c for c in calls if c["phase"] == "repair")
        self.assertIn("Remaining defect 1", json.dumps(repair["request"]["evidence"]))

    def test_explicit_cap_leaves_remaining_review_findings_incomplete(self):
        self.configure(ticket_rounds=3)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("bounded attempts", report["reason"])
        self.assertEqual(report["tickets"]["a"]["attempts"][-1]["review"]["issues"], ["Remaining defect 2"])

    def test_cycles_and_missing_dependencies_rejected_before_execution(self):
        for tickets in ([self.ticket("a", ["b"]), self.ticket("b", ["a"])], [self.ticket("a", ["missing"])]):
            self.plan["tickets"] = tickets
            self.save_plan()
            with self.assertRaises(factory.FactoryError):
                factory.load_plan(self.plan_path)
        self.assertEqual(self.calls(), [])

    def test_empty_verification_inputs_never_green(self):
        original = copy.deepcopy(self.plan)
        for field in ("checks", "integration_checks", "tickets", "ticket_checks", "acceptance"):
            self.plan = copy.deepcopy(original)
            if field == "ticket_checks":
                self.plan["tickets"][0]["checks"] = []
            elif field == "acceptance":
                self.plan["tickets"][0]["acceptance"] = []
            else:
                self.plan[field] = []
            self.save_plan()
            with self.subTest(field=field), self.assertRaises(factory.FactoryError):
                factory.load_plan(self.plan_path)

    def test_failed_ticket_stops_dependants_and_preserves_failure(self):
        self.plan["tickets"].append(self.ticket("b", ["a"]))
        self.plan["max_attempts"] = 1
        self.configure(check_fails=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["tickets"]["b"]["status"], "not_run")
        check = report["tickets"]["a"]["attempts"][0]["checks"][0]
        self.assertEqual(check["exit_code"], 7)
        self.assertIn("expected persisted record", Path(check["stdout"]).read_text())
        self.assertIn("error detail", Path(check["stderr"]).read_text())
        self.assertEqual([c["phase"] for c in self.calls()], ["implement", "check"])

    def test_bounded_repair_receives_real_failure_and_then_passes(self):
        self.configure(repair_needed=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "verified", report.get("reason"))
        self.assertEqual(len(report["tickets"]["a"]["attempts"]), 2)
        repair = next(c for c in self.calls() if c["phase"] == "repair")
        self.assertIn("expected persisted record", repair["request"]["evidence"][0]["stdout_tail"])
        self.assertEqual(repair["request"]["evidence"][0]["exit_code"], 7)

    def test_repeated_failures_stop_at_attempt_budget(self):
        self.configure(check_fails=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(len(report["tickets"]["a"]["attempts"]), 2)
        self.assertEqual([c["phase"] for c in self.calls()].count("repair"), 1)

    def test_no_progress_does_not_repeat_unchanged_failed_checks(self):
        self.configure(check_fails=True, no_progress=True)
        _, report = self.run_factory()
        self.assertIn("no source progress", report["reason"])
        self.assertEqual([c["phase"] for c in self.calls()], ["implement", "check", "repair"])

    def test_malformed_review_stops_without_claiming_success(self):
        self.configure(malformed_review=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIsNone(report["final_review"])
        self.assertIn("Cannot read JSON", report["reason"])

    def test_missing_acceptance_entry_fails_closed(self):
        self.configure(missing_criterion=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("exactly once", report["reason"])

    def test_pending_product_evidence_is_incomplete(self):
        self.configure(pending=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("pending", report["reason"])

    def test_unresolved_decision_stops_before_worker(self):
        self.plan["pending_decisions"] = ["Choose whether delete removes shared records"]
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(self.calls(), [])

    def test_permission_block_never_retried_as_implementation_failure(self):
        self.configure(blocked=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual([c["phase"] for c in self.calls()], ["implement"])

    def test_plan_rewrite_invalidates_run(self):
        self.configure(rewrite_plan=str(self.plan_path))
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("Plan changed", report["reason"])

    def test_source_change_during_check_invalidates_result(self):
        self.configure(check_mutates=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["processes"][-1]["status"], "source_changed")
        self.assertNotIn("review", [c["phase"] for c in self.calls()])

    def test_source_change_during_review_invalidates_result(self):
        self.configure(review_mutates=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["processes"][-1]["status"], "source_changed")

    def test_source_changes_across_tickets_refresh_required_checks(self):
        self.plan["tickets"] = [self.ticket("b", ["a"]), self.ticket("a")]
        _, report = self.run_factory()
        self.assertEqual(report["status"], "verified", report.get("reason"))
        calls = self.calls()
        self.assertEqual([c["request"]["ticket"]["id"] for c in calls if c["phase"] == "implement"], ["a", "b"])
        self.assertEqual([c["phase"] for c in calls].count("check"), 2)
        self.assertEqual(report["final_checks"][0]["inputs_sha256"], report["final_inputs_sha256"])

    def test_final_semantic_defect_gets_bounded_integration_repair(self):
        self.configure(integration_defect=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "verified", report.get("reason"))
        self.assertEqual(len(report["integration_attempts"]), 2)
        calls = self.calls()
        self.assertEqual([c["phase"] for c in calls].count("integration_repair"), 1)
        repair = next(c for c in calls if c["phase"] == "integration_repair")
        self.assertIn("Tickets conflict", repair["request"]["evidence"][0]["review"]["issues"][0])

    def test_final_repair_no_progress_stops(self):
        self.configure(integration_defect=True, no_progress=True)
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("Integration repair made no source progress", report["reason"])

    def test_changed_tracked_untracked_and_staged_inputs_make_report_stale(self):
        controller, report = self.run_factory()
        report_path = controller.output / "report.json"
        for name, content in (("existing.txt", "different"), ("new.txt", "new")):
            target = self.repo / name
            original = target.read_text() if target.exists() else None
            target.write_text(content)
            self.assertEqual(factory.report_status(report_path)["status"], "stale")
            if original is None:
                target.unlink()
            else:
                target.write_text(original)
        self.git("add", "a.txt")
        self.assertEqual(factory.report_status(report_path)["status"], "stale")
        self.assertEqual(report["status"], "verified")

    def test_finalization_race_cannot_rebase_green_evidence(self):
        controller = self.controller()
        original = factory.snapshot
        changed = False
        def concurrent_change(project):
            nonlocal changed
            if controller.report["status"] == "verified" and not changed:
                (self.repo / "late-change.txt").write_text("changed after verification")
                changed = True
            return original(project)
        with patch.object(factory, "snapshot", concurrent_change):
            report = controller.run()
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("finalization", report["reason"])
        self.assertEqual(factory.report_status(controller.output / "report.json")["status"], "incomplete")

    def test_baseline_preserves_prior_local_edits_for_fresh_reviewer(self):
        (self.repo / "existing.txt").write_text("prior user edit\n")
        (self.repo / "user.txt").write_text("prior untracked work")
        _, report = self.run_factory()
        baseline = report["baseline"]
        self.assertIn("prior user edit", Path(baseline["tracked_patch"]).read_text())
        prior = next(p for p in baseline["untracked"] if p["path"] == "user.txt")
        self.assertEqual(Path(prior["snapshot"]).read_text(), "prior untracked work")
        review = next(c for c in self.calls() if c["phase"] == "review")
        self.assertEqual(review["request"]["baseline"], baseline)

    def test_runtime_dependent_checks_are_fresh_by_default(self):
        self.configure(runtime_fixture=True)
        self.plan["checks"][0].pop("cache")
        (self.base / "runtime").write_text("good")
        controller = self.controller()
        self.assertEqual(controller.run_checks(["behavior"])[0]["status"], "passed")
        (self.base / "runtime").write_text("bad")
        second = controller.run_checks(["behavior"])[0]
        self.assertEqual(second["status"], "failed")
        self.assertFalse(second["reused"])
        (self.base / "runtime").write_text("good")
        self.assertEqual(controller.run_checks(["behavior"])[0]["status"], "passed")

    def test_timeout_stops_child_process_group(self):
        self.configure(check_timeout=True)
        self.plan["checks"][0]["timeout_seconds"] = 1
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["processes"][-1]["status"], "timeout")
        pid = int((self.base / "child.pid").read_text())
        self.assert_process_stopped(pid)

    def assert_process_stopped(self, pid):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            # Linux can retain an orphan zombie briefly after group cleanup.
            proc_status = Path(f"/proc/{pid}/stat")
            if proc_status.exists() and proc_status.read_text().split(") ", 1)[1].startswith("Z"):
                return
            time.sleep(0.05)
        self.fail(f"Child {pid} remains running")

    def test_run_wall_clock_budget_caps_worker(self):
        self.configure(worker_timeout=True)
        self.plan["run_timeout_seconds"] = 2
        _, report = self.run_factory()
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["processes"][-1]["status"], "timeout")
        self.assert_process_stopped(int((self.base / "worker.pid").read_text()))

    def test_sigterm_cleans_worker_and_lock(self):
        self.configure(worker_timeout=True)
        self.save_plan()
        output = self.base / "output"
        proc = subprocess.Popen([sys.executable, str(Path(factory.__file__)), "run", str(self.plan_path),
                                 "--output-dir", str(output)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (self.base / "worker.pid").exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.base / "worker.pid").exists())
            lock = factory.repository_lock_path(self.repo)
            acquire = [sys.executable, '-c',
                       "import fcntl, sys; "
                       "lock = open(sys.argv[1], 'a+b'); "
                       "fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)", str(lock)]
            held = subprocess.run(acquire, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(held.returncode, 0, 'Running controller must hold the real lock')
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=5)
            report = json.loads((output / "report.json").read_text())
            self.assertEqual(report["status"], "incomplete")
            self.assertIn("SIGTERM", report["reason"])
            self.assert_process_stopped(int((self.base / "worker.pid").read_text()))
            self.assertTrue(lock.exists())
            acquired = subprocess.run(acquire, capture_output=True, text=True, timeout=5)
            self.assertEqual(acquired.returncode, 0, acquired.stderr)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_built_in_adapter_wire_contracts_apply_claude_worker_policy_only(self):
        # These are fake executables; live CLI help was separately inspected.
        for kind in ("codex", "claude"):
            with self.subTest(kind=kind):
                binary = self.base / kind
                binary.write_text("#!" + sys.executable + "\n" + FAKE)
                binary.chmod(0o755)
                self.plan["worker"] = {"kind": kind, "executable": str(binary)}
                self.save_plan()
                with patch.dict(os.environ, {"PATH": str(self.base) + os.pathsep + os.environ["PATH"],
                                             "FACTORY_TEST_CONTROL": str(self.control)}):
                    controller = factory.Controller(self.plan_path, self.base / ("out-" + kind))
                    report = controller.run()
                self.assertEqual(report["status"], "verified", report.get("reason"))
                worker_argv = [p["argv"] for p in report["processes"] if not p["phase"].startswith("check-")]
                for argv in worker_argv:
                    self.assertEqual(argv[0], str(binary))
                    self.assertNotIn("resume", argv)
                    self.assertNotIn("--resume", argv)
                    self.assertNotIn("--continue", argv)
                    self.assertNotIn("--model", argv)
                    self.assertNotIn("--sandbox", argv)
                    self.assertNotIn("--permission-mode", argv)
                    if kind == "claude":
                        self.assertIn("--no-session-persistence", argv)
                        self.assertEqual(argv.count("--dangerously-skip-permissions"), 1)
                    else:
                        self.assertIn("--ephemeral", argv)
                        self.assertFalse(any("dangerously" in arg for arg in argv))


if __name__ == "__main__":
    unittest.main()
