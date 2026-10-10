"""Focused regressions for intake races, scoped blockers and merge completion."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import factory
import factory_v2
import test_factory_v2 as fixtures


class FactoryRegressions(unittest.TestCase):
    def setUp(self):
        # Compose the existing fixture without inheriting and rerunning its tests.
        self.fixture = fixtures.IsolatedTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def assert_rejected_before_build(self, construct):
        try:
            controller = construct()
        except factory.FactoryError:
            pass
        else:
            report = controller.run()
            self.assertEqual(report['status'], 'incomplete', report.get('reason'))
        self.assertFalse(any(call['phase'] != 'investigate' for call in self.fixture.calls()))

    def test_plan_change_during_validation_cannot_receive_new_file_hash(self):
        f = self.fixture
        f.plan_path.write_text(json.dumps(f.plan))
        original = factory_v2.validate_v1

        def change_after_validation(*args, **kwargs):
            result = original(*args, **kwargs)
            changed = json.loads(f.plan_path.read_text())
            changed['pending_decisions'] = ['Unapproved material product change']
            f.plan_path.write_text(json.dumps(changed))
            return result

        with patch.object(factory_v2, 'validate_v1', change_after_validation):
            self.assert_rejected_before_build(
                lambda: factory_v2.ControllerV2(f.plan_path, f.base / 'output'))

    def test_constructor_cannot_rebaseline_source_after_audit_validation(self):
        f = self.fixture
        investigation = f.investigated_build(question=True)
        f.plan['decisions'] = [{'id': 'choice-p', 'status': 'resolved',
                                'choice': 'Implement', 'reference': f.ref(f.spec)}]
        f.plan['tickets'][0]['decision_ids'] = ['choice-p']
        f.plan_path.write_text(json.dumps(f.plan))
        original = factory_v2.load_plan

        def change_after_intake(*args, **kwargs):
            result = original(*args, **kwargs)
            (f.repo / 'existing.txt').write_text('Source changed after audit validation\n')
            f.git(f.repo, 'add', 'existing.txt')
            f.git(f.repo, 'commit', '-qm', 'Concurrent source change')
            return result

        with patch.object(factory_v2, 'load_plan', change_after_intake):
            self.assert_rejected_before_build(
                lambda: factory_v2.ControllerV2(f.plan_path, f.base / 'build'))
        self.assertEqual(factory_v2.report_status(investigation)['status'], 'stale')

    def test_conflict_resolution_with_unchanged_tree_finishes_merge(self):
        f = self.fixture
        f.plan['tickets'] = [f.ticket('a'), f.ticket('b')]
        f.config(conflict=True, overlap=True)
        # Both tasks change one file. Resolving to b's current tree leaves an
        # empty index diff, but still requires committing the merge parents.
        f.fake.write_text(fixtures.FAKE.replace(
            "(path / (tid + '.txt')).write_text('persisted')", 'pass').replace(
            "(path / 'existing.txt').write_text('both approved changes\\n')",
            "(path / 'existing.txt').write_text('b\\n')"))
        _, report = f.run_factory()
        self.assertEqual(report['status'], 'verified', report.get('reason'))
        task = Path(report['tickets']['b']['repositories']['app']['worktree'])
        self.assertEqual(f.git(task, 'status', '--porcelain'), b'')
        merge_head = subprocess.run(
            ['git', '-C', str(task), 'rev-parse', '--verify', 'MERGE_HEAD'],
            capture_output=True)
        self.assertNotEqual(merge_head.returncode, 0, 'Merge remains unfinished')
        integrated = Path(report['repositories']['app']['worktree'])
        self.assertEqual((integrated / 'existing.txt').read_text(), 'b\n')
        a_head = f.git(Path(report['tickets']['a']['repositories']['app']['worktree']),
                       'rev-parse', 'HEAD').decode().strip()
        f.git(integrated, 'merge-base', '--is-ancestor', a_head, 'HEAD')

    def assert_cli_invalid(self):
        f = self.fixture
        f.plan_path.write_text(json.dumps(f.plan))
        result = subprocess.run(
            [sys.executable, str(Path(factory.__file__)), 'validate', str(f.plan_path)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr or result.stdout)
        self.assertNotIn('Traceback', result.stderr + result.stdout)
        self.assertEqual(json.loads(result.stdout)['status'], 'invalid')

    def test_list_check_repository_returns_structured_invalid(self):
        self.fixture.plan['checks'][0]['repo'] = []
        self.assert_cli_invalid()

    def test_list_audit_point_mapping_returns_structured_invalid(self):
        f = self.fixture
        f.investigated_build()
        f.plan['input']['mappings'][0]['point_id'] = []
        self.assert_cli_invalid()

    def test_pending_decision_stops_only_task_and_its_dependants(self):
        f = self.fixture
        f.plan['decisions'] = [{'id': 'choice-a', 'status': 'pending'}]
        f.plan['tickets'] = [f.ticket('a'), f.ticket('b'), f.ticket('c', ['a'])]
        f.plan['tickets'][0]['decision_ids'] = ['choice-a']
        _, report = f.run_factory()
        self.assertEqual(report['status'], 'incomplete')
        self.assertEqual(report['tickets']['b']['status'], 'integrated')
        for tid in ('a', 'c'):
            self.assertEqual(report['tickets'][tid]['status'], 'not_run')
            self.assertFalse((f.base / (tid + '.started')).exists())
            self.assertFalse(any(call['tid'] == tid for call in f.calls()))
        integrated = Path(report['repositories']['app']['worktree'])
        self.assertTrue((integrated / 'b.txt').exists())
        self.assertFalse((integrated / 'a.txt').exists())

    def test_blocked_audit_point_keeps_unrelated_approved_work(self):
        f = self.fixture
        f.investigated_build()
        f.plan['input']['mappings'][0].update(disposition='blocked', task_ids=[])
        _, report = f.run_factory(output='build')
        self.assertEqual(report['status'], 'incomplete')
        self.assertEqual(report['tickets']['a']['status'], 'integrated')
        self.assertEqual(report['intake']['points'][0]['disposition'], 'blocked')
        self.assertTrue((Path(report['repositories']['app']['worktree']) / 'a.txt').exists())


if __name__ == '__main__':
    unittest.main()
