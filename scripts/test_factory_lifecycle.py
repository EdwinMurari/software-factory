"""Lifecycle CLI regressions with disposable repositories and deterministic workers."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
import fcntl
from unittest.mock import patch

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

    def test_external_edit_before_first_final_process_requires_adoption(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        baseline = owner.baseline

        def edit_before_final(repositories, directory, *args):
            if directory == owner.output / 'original-baselines':
                (owner.integration['app'] / 'unaccounted.txt').write_text('keep this edit')
            return baseline(repositories, directory, *args)

        with patch.object(owner, 'baseline', side_effect=edit_before_final):
            result = owner.run()
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('adopt', result['reason'])
        self.assertFalse(result.get('adoptions'))
        target = owner.integration['app'] / 'unaccounted.txt'
        self.assertEqual(target.read_text(), 'keep this edit')
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        reviews = sum(c['phase'] == 'final_review' for c in self.f.calls())
        code, value = self.cli('adopt', self.report, '--reason', 'Retain approved integration edit')
        self.assertEqual(code, 0, value)
        self.assertEqual(target.read_text(), 'keep this edit')
        self.assertTrue(json.loads(self.report.read_text())['adoptions'])
        self.assertGreater(sum(c['phase'] == 'final_review' for c in self.f.calls()), reviews)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_external_task_edit_between_check_and_review_requires_adoption(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        run_checks = factory_v2.Session.run_checks
        targets = []

        def edit_after_checks(session, ids):
            result = run_checks(session, ids)
            if not targets and session.output == owner.output / 'tasks' / 'a':
                targets.append(session.project / 'unaccounted.txt')
                targets[0].write_text('keep task edit')
            return result

        with patch.object(factory_v2.Session, 'run_checks', new=edit_after_checks):
            result = owner.run()
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('adopt', result['reason'])
        self.assertEqual(targets[0].read_text(), 'keep task edit')
        self.assertFalse(any(c['phase'] == 'review' for c in self.f.calls()))
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        code, value = self.cli('adopt', self.report, '--reason', 'Retain approved task edit')
        self.assertEqual(code, 0, value)
        saved = json.loads(self.report.read_text())
        self.assertEqual((Path(saved['repositories']['app']['worktree']) / 'unaccounted.txt').read_text(), 'keep task edit')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_external_integration_edit_before_task_merge_requires_adoption(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        integrate = owner.integrate

        def edit_before_merge(*args):
            (owner.integration['app'] / 'unaccounted.txt').write_text('keep integration edit')
            return integrate(*args)

        with patch.object(owner, 'integrate', side_effect=edit_before_merge):
            result = owner.run()
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('adopt', result['reason'])
        self.assertEqual(result['integration_order'], [])
        self.assertEqual((owner.integration['app'] / 'unaccounted.txt').read_text(), 'keep integration edit')
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        code, value = self.cli('adopt', self.report, '--reason', 'Retain approved integration edit')
        self.assertEqual(code, 0, value)
        self.assertEqual((owner.integration['app'] / 'unaccounted.txt').read_text(), 'keep integration edit')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_original_baseline_capture_resumes_partial_multi_repository_capture(self):
        other = self.f.make_repo('other').resolve()
        self.f.plan['repositories']['other'] = str(other)
        self.f.plan['tickets'][0]['repos'].append('other')
        self.f.plan['checks'].append(dict(self.f.plan['checks'][0], id='other-contents', repo='other'))
        self.f.plan['tickets'][0]['checks'].append('other-contents')
        self.f.plan['integration_checks'].append('other-contents')
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        capture = factory_v2.capture_baseline
        captured = []

        def interrupted(path, output):
            result = capture(path, output)
            if 'original-baselines' in output.parts:
                captured.append(path)
                if path == other:
                    raise OSError('Interrupted during second original baseline')
            return result

        with patch.object(factory_v2, 'capture_baseline', side_effect=interrupted):
            result = owner.run()
        self.assertIn('Interrupted during second original baseline', result['reason'])
        files = {p: p.read_bytes() for p in (self.output / 'original-baselines').rglob('baseline/*') if p.is_file()}
        self.assertEqual(len(files), 2)
        with patch.object(factory_v2, 'capture_baseline', wraps=capture) as resumed:
            result = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True).run()
        self.assertEqual(result['status'], 'verified', result.get('reason'))
        self.assertEqual([call.args[0] for call in resumed.call_args_list], [other])
        for path, content in files.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(sum(c['phase'] == 'implement' for c in self.f.calls()), 1)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_task_edit_during_final_review_requires_adoption(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        worker = factory_v2.Session.worker

        def edit_after_review(session, phase, *args, **kwargs):
            result = worker(session, phase, *args, **kwargs)
            if phase == 'final_review' and session.output == owner.output / 'final':
                task = Path(owner.report['tickets']['a']['repositories']['app']['worktree'])
                (task / 'a.txt').write_text('retained external edit')
            return result

        with patch.object(factory_v2.Session, 'worker', new=edit_after_review):
            result = owner.run()
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('adopt', result['reason'])
        self.assertFalse(result.get('adoptions'))
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        for _ in range(2):
            code, value = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('adopt', value['reason'])
        code, value = self.cli('adopt', self.report, '--reason', 'Keep approved external task edit')
        self.assertEqual(code, 0, value)
        saved = json.loads(self.report.read_text())
        self.assertEqual((Path(saved['repositories']['app']['worktree']) / 'a.txt').read_text(), 'retained external edit')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

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

    def test_restart_repairs_invalid_worker_result_and_preserves_partial_work(self):
        original = self.f.fake.read_text()
        self.f.fake.write_text(original.replace(
            "issues = []", "if phase == 'implement':\n    print('invalid result')\n    sys.exit()\nissues = []"))
        self.register()
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('Cannot read JSON', result['reason'])
        partial = json.loads(self.report.read_text())
        task = Path(partial['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        logs = {p: p.read_bytes() for p in (self.output / 'tasks').rglob('*.stdout')}
        self.f.fake.write_text(original)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual([c['phase'] for c in self.f.calls() if c['phase'] != 'final_review'],
                         ['implement', 'repair', 'review'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        self.assertEqual((task / 'fix.txt').read_text(), 'x')
        for path, data in logs.items():
            self.assertEqual(path.read_bytes(), data)

    def test_restart_repairs_interrupted_worker_without_restarting_implementation(self):
        original = self.f.fake.read_text()
        self.f.fake.write_text(original.replace(
            "issues = []", "if phase == 'implement': time.sleep(60)\nissues = []"))
        self.f.plan['worker_timeout_seconds'] = 1
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('process timeout', result['reason'])
        partial = json.loads(self.report.read_text())
        task = Path(partial['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        self.f.fake.write_text(original)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual([c['phase'] for c in self.f.calls() if c['phase'] != 'final_review'],
                         ['implement', 'repair', 'review'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        self.assertEqual((task / 'fix.txt').read_text(), 'x')

    def test_no_progress_task_cannot_advance_on_unchanged_continuation(self):
        self.f.config(findings=True, no_progress=True)
        self.register()
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('no source progress', result['reason'])
        calls = self.f.calls()
        task_report = self.output / 'tasks' / 'a' / 'report.json'
        processes = json.loads(task_report.read_text())['processes']
        # A new reviewer answer cannot approve the unchanged failed source.
        self.f.config()
        for _ in range(2):
            code, result = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('no source progress', result['reason'])
            self.assertEqual(self.f.calls(), calls)
            self.assertEqual(json.loads(task_report.read_text())['processes'], processes)

    def test_adopted_task_fix_recovers_persisted_no_progress_stop(self):
        self.f.config(findings=True, no_progress=True)
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        value = json.loads(self.report.read_text())
        task = Path(value['tickets']['a']['repositories']['app']['worktree'])
        (task / 'fix.txt').write_text('explicit adopted fix')
        code, result = self.cli('adopt', self.report, '--reason', 'Retain the approved task fix')
        self.assertEqual(code, 0, result)
        self.assertEqual([c['phase'] for c in self.f.calls() if c['phase'] != 'final_review'],
                         ['implement', 'review', 'repair', 'review'])
        self.assertTrue(any(c['phase'] == 'final_review' for c in self.f.calls()))
        session = json.loads((self.output / 'tasks' / 'a' / 'report.json').read_text())
        self.assertTrue(all(c['status'] == 'passed' for c in session['tickets']['a']['attempts'][-1]['checks']))
        self.assertEqual(session['tickets']['a']['attempts'][-1]['review']['status'], 'complete')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_interrupted_task_repair_before_checks_resumes_valid_source(self):
        self.f.config(findings=True)
        self.register()
        original = factory_v2.Session.run_checks
        def interrupt_repair(session, ids):
            if session.report['tickets']['a']['attempts'][-1]['number'] == 2:
                raise OSError('Interrupted task repair before checks')
            return original(session, ids)
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'run_checks', new=interrupt_repair):
            result = owner.run()
        self.assertIn('Interrupted task repair before checks', result['reason'])
        self.f.config(findings=True, no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual(sum(c['phase'] == 'repair' for c in self.f.calls()), 1)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_completed_task_repair_survives_worker_return_checkpoint(self):
        self.f.config(findings=True)
        self.register()
        original = factory_v2.Session.worker
        def interrupt_return(session, phase, ticket, evidence):
            result = original(session, phase, ticket, evidence)
            if phase == 'repair':
                raise OSError('Interrupted after completed repair worker')
            return result
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'worker', new=interrupt_return):
            result = owner.run()
        self.assertIn('Interrupted after completed repair worker', result['reason'])
        task_report = self.output / 'tasks' / 'a' / 'report.json'
        checkpoint = json.loads(task_report.read_text())
        self.assertEqual(len(checkpoint['tickets']['a']['attempts']), 1)
        task = Path(result['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'fix.txt').read_text(), 'x')
        self.assertFalse(factory.git(task, 'status', '--porcelain'))
        self.f.config(findings=True, no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual(sum(c['phase'] == 'repair' for c in self.f.calls()), 1)
        saved = json.loads(task_report.read_text())['tickets']['a']
        self.assertEqual(saved['attempts'][-1]['review']['status'], 'complete')
        self.assertTrue(all(c['status'] == 'passed' for c in saved['attempts'][-1]['checks']))
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_completed_task_repair_resumes_interrupted_controlled_commit(self):
        self.f.config(findings=True)
        self.register()
        original = factory_v2.Session.git_operation
        def interrupt_commit(session, path, *args, **kwargs):
            if args[0] == 'commit' and (path / 'fix.txt').exists():
                raise OSError('Interrupted repair commit')
            return original(session, path, *args, **kwargs)
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'git_operation', new=interrupt_commit):
            result = owner.run()
        self.assertIn('Interrupted repair commit', result['reason'])
        task = Path(result['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'fix.txt').read_text(), 'x')
        self.assertTrue(factory.git(task, 'status', '--porcelain'))
        self.f.config(findings=True, no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertFalse(factory.git(task, 'status', '--porcelain'))
        self.assertEqual(sum(c['phase'] == 'repair' for c in self.f.calls()), 1)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_worker_return_recovery_keeps_worker_head_restriction(self):
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "issues = []", "if phase == 'implement':\n    for path in paths.values():\n        subprocess.run(['git', '-C', str(path), 'add', '-A'], check=True)\n        subprocess.run(['git', '-C', str(path), 'commit', '-m', 'Illegal worker commit'], check=True, stdout=sys.stderr)\nissues = []"))
        self.register()
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('Worker changed Git HEAD', result['reason'])
        calls = self.f.calls()
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('Worker changed Git HEAD', result['reason'])
        self.assertEqual(self.f.calls(), calls)

    def test_worker_return_recovery_rejects_unchanged_repair(self):
        self.f.config(findings=True, no_progress=True)
        self.register()
        original = factory_v2.Session.worker
        def interrupt_return(session, phase, ticket, evidence):
            result = original(session, phase, ticket, evidence)
            if phase == 'repair':
                raise OSError('Interrupted unchanged repair return')
            return result
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'worker', new=interrupt_return):
            result = owner.run()
        self.assertIn('Interrupted unchanged repair return', result['reason'])
        calls = self.f.calls()
        self.f.config()
        for _ in range(2):
            code, result = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('no source progress', result['reason'])
            self.assertEqual(self.f.calls(), calls)

    def test_blocked_integration_worker_can_retry_after_restart(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'].append({'id': 'final-only', 'repo': 'app', 'argv':
            [sys.executable, '-c', "from pathlib import Path; assert Path('fix.txt').exists()"]})
        self.f.plan['integration_checks'] = ['final-only']
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "if control.get('pending') and 'review' in phase: status = 'blocked'",
            "if control.get('block_integration') and phase == 'integration_repair': status = 'blocked'\nif control.get('pending') and 'review' in phase: status = 'blocked'"))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.f.config(block_integration=True)
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('Integration repair blocked', result['reason'])
        self.f.config(no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual(sum(c['phase'] == 'integration_repair' for c in self.f.calls()), 2)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_integration_failed_content_cycle_stops_across_restarts(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'].append({'id': 'final-only', 'repo': 'app', 'argv':
            [sys.executable, '-c', "from pathlib import Path; print(Path('cycle.txt').read_text() if Path('cycle.txt').exists() else 'absent'); raise SystemExit(1)"]})
        self.f.plan['integration_checks'] = ['final-only']
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "if phase in ('repair', 'integration_repair') and not control.get('no_progress'):",
            "if phase == 'integration_repair':\n    for path in paths.values():\n        p = path / 'cycle.txt'\n        p.write_text('B' if p.exists() and p.read_text() == 'A' else 'A')\nif phase == 'repair' and not control.get('no_progress'):"))
        self.register()
        for _ in range(4):
            code, result = self.cli('continue', self.report)
            self.assertNotEqual(code, 0, result)
        self.assertIn('no source progress', result['reason'])
        final_path = self.output / 'final' / 'report.json'
        saved = json.loads(final_path.read_text())
        outputs = [Path(a['checks'][-1]['stdout']).read_text().strip() for a in saved['integration_attempts']]
        self.assertEqual(outputs, ['absent', 'A', 'B'])
        calls = self.f.calls()
        self.f.config(no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertNotEqual(code, 0, result)
        self.assertIn('no source progress', result['reason'])
        self.assertEqual(self.f.calls(), calls)
        self.assertEqual(json.loads(final_path.read_text())['integration_attempts'], saved['integration_attempts'])

    def test_bounded_failed_check_continues_with_repair(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'][0]['argv'] = [sys.executable, '-c',
                                          "from pathlib import Path; assert Path('fix.txt').exists()"]
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        before = json.loads(self.report.read_text())
        self.assertEqual([c['phase'] for c in self.f.calls()], ['implement'])
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        repair = next(c for c in self.f.calls() if c['phase'] == 'repair')
        self.assertIn('failed', json.dumps(repair['request']['evidence']))
        self.assertEqual(json.loads(self.report.read_text())['run_id'], before['run_id'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_final_bounded_failure_repairs_on_continuation(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'].append({'id': 'final-only', 'repo': 'app', 'argv':
            [sys.executable, '-c', "from pathlib import Path; assert Path('fix.txt').exists()"]})
        self.f.plan['integration_checks'] = ['final-only']
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        final_path = self.output / 'final' / 'report.json'
        before = json.loads(final_path.read_text())
        self.assertEqual(before['integration_attempts'][-1]['checks'][-1]['status'], 'failed')
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        repair = next(c for c in self.f.calls() if c['phase'] == 'integration_repair')
        self.assertIn('failed', json.dumps(repair['request']['evidence']))
        self.assertEqual(len(json.loads(final_path.read_text())['integration_attempts']), 2)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_adopted_fix_rechecks_previous_integration_failure(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'].append({'id': 'final-only', 'repo': 'app', 'argv':
            [sys.executable, '-c', "from pathlib import Path; assert Path('fix.txt').exists()"]})
        self.f.plan['integration_checks'] = ['final-only']
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.f.config(no_progress=True)
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        before = json.loads(self.report.read_text())
        final_path = self.output / 'final' / 'report.json'
        failed = json.loads(final_path.read_text())
        self.assertEqual(failed['integration_attempts'][-1]['checks'][-1]['status'], 'failed')
        # The same failing state still needs a real repair, even across restart.
        for _ in range(2):
            code, result = self.cli('continue', self.report)
            self.assertNotEqual(code, 0)
            self.assertIn('Integration repair made no source progress', result['reason'])
        target = Path(before['repositories']['app']['worktree']) / 'fix.txt'
        target.write_text('approved fix')
        code, result = self.cli('adopt', self.report, '--reason', 'Retain the approved integration fix')
        self.assertEqual(code, 0, result)
        self.assertEqual(target.read_text(), 'approved fix')
        final = json.loads(final_path.read_text())
        self.assertEqual(len(final['integration_attempts']), 2)
        self.assertTrue(all(c['status'] == 'passed' for c in final['final_checks']))
        self.assertNotEqual(final['final_checks'][-1]['inputs_sha256'],
                            failed['integration_attempts'][-1]['checks'][-1]['inputs_sha256'])
        self.assertEqual(final['final_review']['status'], 'complete')
        self.assertEqual(json.loads(self.report.read_text())['run_id'], before['run_id'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_integration_repair_interrupted_before_checks_revalidates_retained_fix(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan['checks'].append({'id': 'final-only', 'repo': 'app', 'argv':
            [sys.executable, '-c', "from pathlib import Path; assert Path('fix.txt').exists()"]})
        self.f.plan['integration_checks'] = ['final-only']
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'run_checks', side_effect=OSError('Interrupted before checks')):
            result = owner.run()
        self.assertIn('Interrupted before checks', result['reason'])
        target = Path(result['repositories']['app']['worktree']) / 'fix.txt'
        self.assertEqual(target.read_text(), 'x')
        self.f.config(no_progress=True)
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual(target.read_text(), 'x')
        self.assertEqual(len([c for c in self.f.calls() if c['phase'] == 'integration_repair']), 1)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_failed_adoption_commit_resumes_without_losing_evidence(self):
        value = self.build()
        root = Path(value['repositories']['app']['worktree'])
        (root / 'retained.txt').write_text('retain through failed commit')
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        git_operation = factory_v2.Session.git_operation
        def failed_commit(session, path, *args, **kwargs):
            if args[0] == 'commit':
                return git_operation(session, path, 'commit', '--invalid-factory-test-option')
            return git_operation(session, path, *args, **kwargs)
        with patch.object(factory_v2.Session, 'git_operation', new=failed_commit):
            result = owner.run('adopt', 'Keep approved correction')
        self.assertIn('Git commit failed', result['reason'])
        saved = json.loads(self.report.read_text())
        self.assertEqual(len(saved.get('adoptions', [])), 1)
        captures = {p: p.read_bytes() for p in (self.output / 'adoptions').rglob('*') if p.is_file() and p.name != 'report.json'}
        self.assertTrue(any(p.suffix == '.stderr' for p in captures))
        code, value = self.cli('adopt', self.report, '--reason', 'Retry approved correction')
        self.assertEqual(code, 0, value)
        for path, content in captures.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(len(json.loads(self.report.read_text())['adoptions']), 1)
        self.assertEqual((root / 'retained.txt').read_text(), 'retain through failed commit')
        self.assertFalse(factory.git(root, 'status', '--porcelain'))
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_interrupted_adoption_capture_retries_and_preserves_partial_files(self):
        value = self.build()
        root = Path(value['tickets']['a']['repositories']['app']['worktree'])
        (root / 'retained.txt').write_text('retain despite interrupted capture')
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        capture = factory.capture_baseline
        def interrupted(path, output):
            capture(path, output)
            raise OSError('Interrupted after capture files were written')
        # Simulate a process exit before finalization; only durable checkpoints survive.
        def leave_checkpoint():
            for stream in owner.locks:
                stream.close()
        with patch.object(factory, 'capture_baseline', side_effect=interrupted), patch.object(owner, 'finalize', side_effect=leave_checkpoint):
            result = owner.run('adopt', 'Retain approved task correction')
        self.assertIn('Interrupted after capture', result['reason'])
        before = json.loads(self.report.read_text())
        self.assertTrue(before['operation_open'])
        captures = {p: p.read_bytes() for p in (self.output / 'adoptions').rglob('*') if p.is_file()}
        self.assertTrue(captures)
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        for path, content in captures.items():
            self.assertEqual(path.read_bytes(), content)
        saved = json.loads(self.report.read_text())
        self.assertEqual(len(saved['adoptions']), 1)
        change = saved['adoptions'][0]['changes'][str(root)]
        self.assertEqual(len(change['captures']), 2)
        self.assertEqual((Path(saved['repositories']['app']['worktree']) / 'retained.txt').read_text(), 'retain despite interrupted capture')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_adoption_task_report_mutation_survives_exit_before_finalization(self):
        import factory_lifecycle
        value = self.build()
        root = Path(value['tickets']['a']['repositories']['app']['worktree'])
        (root / 'retained.txt').write_text('retained across report mutation')
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        atomic = factory_lifecycle.atomic
        def interrupted(path, value):
            atomic(path, value)
            if path == (self.output / 'tasks' / 'a' / 'report.json').resolve():
                raise OSError('Interrupted after task report mutation')
        def leave_checkpoint():
            for stream in owner.locks:
                stream.close()
        with patch.object(factory_lifecycle, 'atomic', side_effect=interrupted), patch.object(owner, 'finalize', side_effect=leave_checkpoint):
            result = owner.run('adopt', 'Retain approved task change')
        self.assertIn('Interrupted after task report mutation', result['reason'])
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        saved = json.loads(self.report.read_text())
        self.assertEqual(len(saved['adoptions']), 1)
        self.assertEqual((Path(saved['repositories']['app']['worktree']) / 'retained.txt').read_text(), 'retained across report mutation')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_final_bounded_review_finding_repairs_on_continuation(self):
        self.f.plan['max_attempts'] = 1
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "if control.get('findings') and 'review' in phase",
            "if phase == 'final_review' and '/integration/' in str(next(iter(paths.values())))"))
        self.register()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        final_path = self.output / 'final' / 'report.json'
        before = json.loads(final_path.read_text())
        self.assertEqual(before['integration_attempts'][-1]['review']['issues'], ['Missing fix.txt'])
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        repair = next(c for c in self.f.calls() if c['phase'] == 'integration_repair')
        self.assertIn('Missing fix.txt', json.dumps(repair['request']['evidence']))
        self.assertEqual(len(json.loads(final_path.read_text())['integration_attempts']), 2)

    def test_setup_only_worktree_edits_require_adoption(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        original = owner.worktree
        def interrupted(name, source, role, base):
            result = original(name, source, role, base)
            if role == 'task-a':
                raise OSError('Interrupted before task setup checkpoint')
            return result
        def leave_checkpoint():
            for stream in owner.locks:
                stream.close()
        with patch.object(owner, 'worktree', side_effect=interrupted), patch.object(owner, 'finalize', side_effect=leave_checkpoint):
            result = owner.run()
        self.assertIn('Interrupted before task setup', result['reason'])
        setup = next(r for r in result['worktree_setups'] if r['role'] == 'task-a')
        root = Path(setup['worktree'])
        (root / 'retained.txt').write_text('retain setup-only content')
        self.f.git(root, 'add', '.')
        self.f.git(root, 'commit', '-qm', 'Out of run edit')
        code, value = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('adopt', value['reason'])
        (root / 'dirty.txt').write_text('also retain uncommitted content')
        code, value = self.cli('adopt', self.report, '--reason', 'Keep approved setup changes')
        self.assertEqual(code, 0, value)
        saved = json.loads(self.report.read_text())
        integrated = Path(saved['repositories']['app']['worktree'])
        self.assertEqual((integrated / 'retained.txt').read_text(), 'retain setup-only content')
        self.assertEqual((integrated / 'dirty.txt').read_text(), 'also retain uncommitted content')
        session = json.loads((self.output / 'tasks' / 'a' / 'report.json').read_text())
        self.assertEqual(session['baseline']['app']['head'], setup['base_sha'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def interrupt_task_baseline(self):
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        original = owner.baseline

        def interrupted(repositories, directory, *args, **kwargs):
            if directory == (self.output / 'tasks' / 'a').resolve():
                (directory / 'app' / 'baseline').mkdir(parents=True, exist_ok=True)
                raise OSError('Interrupted task baseline capture')
            return original(repositories, directory, *args, **kwargs)

        with patch.object(owner, 'baseline', side_effect=interrupted):
            result = owner.run()
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('Interrupted task baseline', result['reason'])
        self.assertEqual(self.f.calls(), [])
        return result

    def test_interrupted_task_baseline_continues_on_same_run(self):
        before = self.interrupt_task_baseline()
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        self.assertEqual(json.loads(self.report.read_text())['run_id'], before['run_id'])
        self.assertEqual(sum(c['phase'] == 'implement' for c in self.f.calls()), 1)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_interrupted_task_baseline_retains_edits_only_after_adoption(self):
        before = self.interrupt_task_baseline()
        setup = next(r for r in before['worktree_setups'] if r['role'] == 'task-a')
        task = Path(setup['worktree'])
        (task / 'retained.txt').write_text('explicit retained change')
        code, value = self.cli('continue', self.report)
        self.assertNotEqual(code, 0)
        self.assertIn('adopt', value['reason'])
        code, value = self.cli('adopt', self.report, '--reason', 'Retain approved correction')
        self.assertEqual(code, 0, value)
        report = json.loads(self.report.read_text())
        integrated = Path(report['repositories']['app']['worktree'])
        self.assertEqual((integrated / 'retained.txt').read_text(), 'explicit retained change')
        session = json.loads((self.output / 'tasks' / 'a' / 'report.json').read_text())
        self.assertEqual(session['baseline']['app']['head'], setup['base_sha'])
        self.assertEqual(session['baseline']['app']['untracked'], [])
        self.assertEqual(Path(session['baseline']['app']['tracked_patch']).read_text(), '')
        self.assertTrue(report['adoptions'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

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

    def test_delayed_lifecycle_openers_preserve_newer_completed_evidence(self):
        import factory_lifecycle
        self.register()
        actions = ('continue', 'adopt', 'reopen', 'complete')
        delayed = {action: factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
                   for action in actions}
        self.assertEqual(self.cli('continue', self.report)[0], 0)
        completed = json.loads(self.report.read_text())
        self.assertEqual(completed['status'], 'verified')
        self.assertTrue(completed['tickets']['a']['attempts'])
        preserved = {p: p.read_bytes() for p in self.output.rglob('*') if p.is_file()}
        preserved.update({Path(p): Path(p).read_bytes() for p in completed['registry_paths']})
        calls = self.f.calls()
        findings = self.f.base / 'late.json'
        findings.write_text(json.dumps(['Retain the newer evidence before repairing this finding']))
        for action, owner in delayed.items():
            with self.subTest(action=action):
                if action == 'complete':
                    with patch.object(factory_v2, 'ControllerV2', return_value=owner):
                        with self.assertRaisesRegex(factory.FactoryError, 'Report changed'):
                            factory_lifecycle.operate(self.report, action)
                else:
                    result = owner.run(action, 'Retain approved edits', findings)
                    self.assertEqual(result['status'], 'incomplete')
                    self.assertIn('Report changed', result['reason'])
                for path, data in preserved.items():
                    self.assertEqual(path.read_bytes(), data, str(path))
                self.assertEqual(self.f.calls(), calls)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_delayed_new_opener_cannot_replace_completed_run(self):
        first = factory_v2.ControllerV2(self.f.plan_path, self.output)
        delayed = factory_v2.ControllerV2(self.f.plan_path, self.output)
        self.assertEqual(first.run()['status'], 'verified')
        before = self.report.read_bytes()
        claim = Path(json.loads(before)['registry_paths'][0])
        claim_before = claim.read_bytes()
        calls = self.f.calls()
        result = delayed.run('register')
        self.assertEqual(self.report.read_bytes(), before)
        self.assertEqual(claim.read_bytes(), claim_before)
        self.assertEqual(result['status'], 'incomplete')
        self.assertIn('Report changed', result['reason'])
        self.assertEqual(self.f.calls(), calls)


if __name__ == '__main__':
    unittest.main()
