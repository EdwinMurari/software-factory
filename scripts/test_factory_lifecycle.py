"""Lifecycle CLI regressions with disposable repositories and deterministic workers."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
import fcntl

import factory
import factory_v2
import test_factory_v2 as fixtures


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.IsolatedTests()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.output = self.f.base / 'run'
        self.report = self.output / 'report.json'

    def cli(self, *args):
        result = subprocess.run([sys.executable, str(Path(factory.__file__)), *map(str, args)],
                                capture_output=True, text=True, timeout=90)
        self.assertTrue(result.stdout, result.stderr)
        return result.returncode, json.loads(result.stdout)

    def register(self):
        code, value = self.cli('register', self.f.plan_path, '--output-dir', self.output)
        self.assertEqual(code, 0, value)
        self.assertEqual(value['status'], 'registered')

    def build(self):
        self.register()
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        return json.loads(self.report.read_text())

    def test_register_records_identity_and_prevents_output_bypass(self):
        self.register()
        before = json.loads(self.report.read_text())
        self.assertTrue(before['run_id'])
        self.assertEqual(self.f.calls(), [])
        code, value = self.cli('run', self.f.plan_path, '--output-dir', self.f.base / 'bypass')
        self.assertNotEqual(code, 0)
        self.assertIn('active run', value['reason'])
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        self.assertEqual(json.loads(self.report.read_text())['run_id'], before['run_id'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_status_string_cannot_skip_execution(self):
        self.register()
        value = json.loads(self.report.read_text())
        value['status'] = 'verified'
        self.report.write_text(json.dumps(value))
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertNotEqual(self.cli('status', self.report)[0], 0)
        self.assertEqual(self.f.calls(), [])

    def test_late_edit_rejected_repeatedly_then_adopted_and_reviewed(self):
        value = self.build()
        target = Path(value['repositories']['app']['worktree']) / 'report.json'
        target.write_text('explicitly retained content')
        before = self.report.read_bytes()
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        for _ in range(2):
            code, result = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('adopt', result['reason'])
            self.assertEqual(self.report.read_bytes(), before)
        reviews = len([c for c in self.f.calls() if c['phase'] == 'final_review'])
        code, result = self.cli('adopt', self.report, '--reason', 'Keep the specified extra file')
        self.assertEqual(code, 0, result)
        self.assertEqual(target.read_text(), 'explicitly retained content')
        self.assertGreater(len([c for c in self.f.calls() if c['phase'] == 'final_review']), reviews)
        self.assertTrue(json.loads(self.report.read_text())['adoptions'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)
        # A source file named report.json is content, not a process checkpoint.
        self.assertEqual(self.cli('continue', self.report)[0], 0)

    def test_late_findings_dispatch_repair_on_same_run(self):
        value = self.build()
        findings = self.f.base / 'late.json'
        findings.write_text(json.dumps(['The persisted record needs the missing fix marker']))
        calls = len(self.f.calls())
        code, result = self.cli('reopen', self.report, '--findings', findings)
        self.assertEqual(code, 0, result)
        phases = [c['phase'] for c in self.f.calls()[calls:]]
        self.assertIn('integration_repair', phases)
        self.assertIn('final_review', phases)
        self.assertNotIn('implement', phases)
        updated = json.loads(self.report.read_text())
        self.assertEqual(updated['run_id'], value['run_id'])
        self.assertTrue(updated['findings'][0]['resolved'])

    def test_restart_preserves_failed_worker_edits_and_attempt_logs(self):
        self.f.config(crash='a')
        self.register()
        code, value = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        partial = json.loads(self.report.read_text())
        task = Path(partial['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        logs = {p: p.read_bytes() for p in (self.output / 'tasks').rglob('*.stdout')}
        self.f.config()
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        self.assertEqual(sum(c['phase'] == 'implement' for c in self.f.calls()), 1)
        self.assertIn('repair', [c['phase'] for c in self.f.calls()])
        for path, data in logs.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')

    def test_completed_implementation_is_not_restarted_after_review_crash(self):
        original = self.f.fake.read_text()
        self.f.fake.write_text(original.replace("phase = r['phase']", "phase = r['phase']\nif phase == 'review': sys.exit(13)"))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.f.fake.write_text(original)
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        self.assertEqual(sum(c['phase'] == 'implement' for c in self.f.calls()), 1)
        self.assertNotIn('repair', [c['phase'] for c in self.f.calls()])

    def test_task_worktree_edits_return_through_integration(self):
        value = self.build()
        task = Path(value['tickets']['a']['repositories']['app']['worktree'])
        (task / 'retained.txt').write_text('retained task edit')
        code, result = self.cli('adopt', self.report, '--reason', 'Retain the approved task correction')
        self.assertEqual(code, 0, result)
        integrated = Path(value['repositories']['app']['worktree'])
        self.assertEqual((integrated / 'retained.txt').read_text(), 'retained task edit')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_empty_check_set_cannot_pass_even_with_matching_file_hashes(self):
        self.build()
        session_path = self.output / 'final' / 'report.json'
        session = json.loads(session_path.read_text())
        session['final_checks'] = []
        session_path.write_text(json.dumps(session))
        report = json.loads(self.report.read_text())
        report['final_checks'] = []
        for reference in report['evidence_files']:
            if reference['path'] == str(session_path.resolve()):
                reference['sha256'] = factory.digest(session_path.read_bytes())
        self.report.write_text(json.dumps(report))
        code, value = self.cli('complete', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('required check', value['reason'])

    def test_explicit_close_preserves_retained_work_and_releases_changed_input_run(self):
        self.f.config(crash='a')
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        old = json.loads(self.report.read_text())
        task = Path(old['tickets']['a']['repositories']['app']['worktree'])
        self.f.spec.write_text('A newly agreed product scope')
        self.f.plan['spec'] = self.f.ref(self.f.spec)
        self.f.plan['tickets'][0]['source'] = self.f.ref(self.f.spec)
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        code, value = self.cli('register', self.f.plan_path, '--output-dir', self.f.base / 'bypass')
        self.assertNotEqual(code, 0)
        self.assertIn('active run', value['reason'])
        code, value = self.cli('close', self.report, '--reason', 'User ended this scope and approved a separate replacement')
        self.assertEqual(code, 0, value)
        self.assertEqual(value['status'], 'closed')
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertEqual(self.cli('register', self.f.plan_path, '--output-dir', self.f.base / 'replacement')[0], 0)
        closed = json.loads(self.report.read_text())
        self.assertEqual(closed['closure']['previous_status'], 'incomplete')
        self.assertEqual(closed['plan_sha256'], old['plan_sha256'])
        self.assertEqual(closed['evidence_files'], old['evidence_files'])

    def test_close_releases_claim_when_original_linked_checkout_is_missing(self):
        linked = self.f.base / 'linked-source'
        self.f.git(self.f.repo, 'worktree', 'add', '-qb', 'linked-source', str(linked))
        self.f.plan['repositories']['app'] = str(linked)
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        self.f.git(self.f.repo, 'worktree', 'remove', str(linked))
        code, result = self.cli('close', self.report, '--reason', 'User ended work on the removed checkout')
        self.assertEqual(code, 0, result)
        self.f.plan['repositories']['app'] = str(self.f.repo)
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.assertEqual(self.cli('register', self.f.plan_path, '--output-dir', self.f.base / 'replacement')[0], 0)

    def test_required_evidence_cannot_be_removed(self):
        self.build()
        value = json.loads(self.report.read_text())
        value['evidence_files'] = []
        self.report.write_text(json.dumps(value))
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)

    def test_changed_requirements_are_not_adoptable(self):
        self.build()
        self.f.spec.write_text('A different unapproved scope')
        code, value = self.cli('adopt', self.report, '--reason', 'Attempted input change')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.f.spec.read_text(), 'A different unapproved scope')

    def test_repository_lock_rejects_concurrent_continuation_without_report_changes(self):
        self.register()
        before = self.report.read_bytes()
        with factory.repository_lock_path(self.f.repo).open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, value = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('repository lock', value['reason'])
        self.assertEqual(self.report.read_bytes(), before)
        self.assertEqual(self.cli('continue', self.report)[0], 0)


if __name__ == '__main__':
    unittest.main()
