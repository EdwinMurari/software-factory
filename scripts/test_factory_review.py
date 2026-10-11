"""Review-entry CLI journeys against real dirty Git worktrees."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import factory_v2

import test_factory_lifecycle as lifecycle
import factory


class ReviewTests(unittest.TestCase):
    cli = lifecycle.LifecycleTests.cli
    register = lifecycle.LifecycleTests.register
    def setUp(self):
        lifecycle.LifecycleTests.setUp(self)
        self.baseline = self.f.git(self.f.repo, 'rev-parse', 'HEAD').decode().strip()
        self.f.plan['input'] = {'kind': 'review', 'baselines': {'app': self.baseline}}
        self.f.plan_path.write_text(json.dumps(self.f.plan))

    def configure(self, **values):
        self.f.control.write_text(json.dumps(values))

    def review(self, only=False):
        if only:
            self.f.plan['input']['review_only'] = True
            self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        code, value = self.cli('continue', self.report)
        return code, value, json.loads(self.report.read_text())

    def test_dirty_committed_staged_untracked_modes_are_preserved(self):
        repo = self.f.repo
        (repo / 'committed.txt').write_text('committed change')
        self.f.git(repo, 'add', '.')
        self.f.git(repo, 'commit', '-qm', 'existing work')
        (repo / 'existing.txt').write_text('staged\n')
        self.f.git(repo, 'add', '.')
        (repo / 'existing.txt').write_text('unstaged\n')
        (repo / 'executable').write_text('run')
        (repo / 'executable').chmod(0o751)
        (repo / 'link').symlink_to('existing.txt')
        before = factory.snapshot(repo)
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        self.assertEqual(factory.snapshot(repo), before)
        copy = Path(report['repositories']['app']['worktree'])
        self.assertEqual((copy / 'existing.txt').read_text(), 'unstaged\n')
        self.assertEqual(self.f.git(copy, 'show', ':existing.txt'), b'staged\n')
        self.assertEqual((copy / 'executable').stat().st_mode & 0o777, 0o751)
        self.assertEqual(os.readlink(copy / 'link'), 'existing.txt')
        calls = self.f.calls()
        self.assertEqual([c['phase'] for c in calls], ['final_review'])
        baseline = calls[0]['request']['baseline']['app']
        self.assertEqual(baseline['head'], self.baseline)
        self.assertEqual(Path(baseline['tracked_patch']).read_bytes(), b'')
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_deleted_tracked_file_replaced_by_directory(self):
        self.assert_tracked_file_replaced_by_directory(staged=True)

    def test_unstaged_tracked_file_replaced_by_directory(self):
        self.assert_tracked_file_replaced_by_directory(staged=False)

    def assert_tracked_file_replaced_by_directory(self, staged):
        repo = self.f.repo
        if staged:
            self.f.git(repo, 'rm', 'existing.txt')
        else:
            (repo / 'existing.txt').unlink()
        (repo / 'existing.txt').mkdir()
        (repo / 'existing.txt' / 'child.txt').write_text('replacement child')
        self.f.plan['checks'][0]['argv'][-1] = (
            "from pathlib import Path; assert Path('existing.txt/child.txt').read_text() == 'replacement child'")
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        before = self.f.git(repo, 'status', '--porcelain=v1', '-z')
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        copy = Path(report['repositories']['app']['worktree'])
        self.assertEqual((copy / 'existing.txt/child.txt').read_text(), 'replacement child')
        self.assertEqual(self.f.git(repo, 'status', '--porcelain=v1', '-z'), before)
        self.assertEqual(self.f.git(copy, 'status', '--short'), self.f.git(repo, 'status', '--short'))
        self.assertEqual(self.f.git(copy, 'ls-files', '--stage'), self.f.git(repo, 'ls-files', '--stage'))
        self.assertEqual((repo / 'existing.txt/child.txt').read_text(), 'replacement child')
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_unstaged_tracked_directory_replaced_by_regular_file(self):
        repo = self.f.repo
        directory = repo / 'directory'
        directory.mkdir()
        child = directory / 'tracked.txt'
        child.write_text('old tracked content')
        self.f.git(repo, 'add', '.')
        self.f.git(repo, 'commit', '-qm', 'tracked directory')
        child.unlink()
        directory.rmdir()
        directory.write_text('replacement file')
        self.f.plan['checks'][0]['argv'][-1] = (
            "from pathlib import Path; assert Path('directory').read_text() == 'replacement file'")
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        before = self.f.git(repo, 'status', '--porcelain=v1', '-z')
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        copy = Path(report['repositories']['app']['worktree'])
        self.assertEqual((copy / 'directory').read_text(), 'replacement file')
        self.assertEqual(self.f.git(repo, 'status', '--porcelain=v1', '-z'), before)
        self.assertEqual(self.f.git(copy, 'status', '--short'), self.f.git(repo, 'status', '--short'))
        self.assertEqual(self.f.git(copy, 'diff', '--cached'), self.f.git(repo, 'diff', '--cached'))
        self.assertEqual((repo / 'directory').read_text(), 'replacement file')
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def tracked_link(self):
        link = self.f.repo / 'link'
        link.symlink_to('existing.txt')
        self.f.git(self.f.repo, 'add', 'link')
        self.f.git(self.f.repo, 'commit', '-qm', 'tracked symlink')
        return link.lstat().st_mode & 0o777

    def test_report_only_same_bytes_and_mode_type_mutation_is_stale(self):
        mode = self.tracked_link()
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        link = Path(report['repositories']['app']['worktree']) / 'link'
        link.unlink()
        link.write_text('existing.txt')
        link.chmod(mode)
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'stale')
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])

    def test_same_bytes_and_mode_type_repair_is_source_progress(self):
        mode = self.tracked_link()
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "p = path / 'fix.txt'\n        p.write_text(p.read_text() + 'x' if p.exists() else 'x')",
            "p = path / 'link'\n        mode = p.lstat().st_mode & 0o777\n"
            "        p.unlink()\n        p.write_text('existing.txt')\n        p.chmod(mode)").replace(
            "not all((p/'fix.txt').exists() for p in paths.values())",
            "any((p/'link').is_symlink() for p in paths.values())"))
        self.configure(findings=True)
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        link = Path(report['repositories']['app']['worktree']) / 'link'
        self.assertFalse(link.is_symlink())
        self.assertEqual(link.read_text(), 'existing.txt')
        self.assertEqual(link.stat().st_mode & 0o777, mode)
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual([c['phase'] for c in self.f.calls()],
                         ['final_review', 'integration_repair', 'final_review'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_deleted_tracked_directory_replaced_by_symlink(self):
        repo = self.f.repo
        directory = repo / 'directory'
        directory.mkdir()
        (directory / 'tracked.txt').write_text('old tracked content')
        self.f.git(repo, 'add', '.')
        self.f.git(repo, 'commit', '-qm', 'tracked directory')
        self.f.git(repo, 'rm', '-r', 'directory')
        external = self.f.base / 'external'
        external.mkdir()
        (external / 'tracked.txt').write_text('external content')
        directory.symlink_to(external, target_is_directory=True)
        before = factory.snapshot(repo)
        self.f.plan['checks'][0]['argv'][-1] = (
            "from pathlib import Path; assert Path('directory').is_symlink(); "
            "assert Path('directory/tracked.txt').read_text() == 'external content'")
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        copy = Path(report['repositories']['app']['worktree'])
        self.assertEqual(os.readlink(copy / 'directory'), str(external))
        self.assertEqual((external / 'tracked.txt').read_text(), 'external content')
        self.assertEqual(factory.snapshot(repo), before)
        self.assertEqual(self.f.git(copy, 'status', '--short'), self.f.git(repo, 'status', '--short'))
        self.assertEqual(self.f.git(copy, 'diff', '--cached'), self.f.git(repo, 'diff', '--cached'))
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_intent_to_add_preserved_and_flag_change_is_stale(self):
        repo = self.f.repo
        (repo / 'new.txt').write_text('pending content')
        (repo / 'pending executable').write_text('run')
        (repo / 'pending executable').chmod(0o755)
        (repo / 'pending link').symlink_to('new.txt')
        (repo / 'pending\nname').write_text('path with newline')
        (repo / 'deleted pending').write_text('removed later')
        self.f.git(repo, 'add', '-N', '.')
        (repo / 'deleted pending').unlink()
        self.f.git(repo, 'update-index', '--assume-unchanged', 'existing.txt')
        before = factory.snapshot(repo)
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        copy = Path(report['repositories']['app']['worktree'])
        self.assertEqual(self.f.git(copy, 'status', '--short'), self.f.git(repo, 'status', '--short'))
        self.assertEqual(self.f.git(copy, 'diff', '--cached', '--name-status'), b'')
        self.assertEqual(self.f.git(copy, 'diff'), self.f.git(repo, 'diff'))
        self.assertEqual(factory.snapshot(repo), before)
        self.assertEqual(self.cli('complete', self.report)[0], 0)
        # Keep the blob and mode, but clear intent-to-add.
        self.f.git(copy, 'update-index', '--cacheinfo',
                   '100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,new.txt')
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'stale')

    def test_failed_initial_check_is_reviewed_before_repair(self):
        self.f.plan['checks'][0]['argv'][-1] = "from pathlib import Path; assert Path('fix.txt').exists()"
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        calls = self.f.calls()
        self.assertEqual([c['phase'] for c in calls],
                         ['final_review', 'integration_repair', 'final_review'])
        initial = report['integration_attempts'][0]
        self.assertEqual(initial['checks'][0]['status'], 'failed')
        self.assertEqual(calls[0]['request']['evidence'][0]['status'], 'failed')
        self.assertTrue(all(c['status'] == 'passed' for c in report['final_checks']))
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_findings_repair_then_fresh_review(self):
        self.configure(findings=True)
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        calls = self.f.calls()
        self.assertEqual([c['phase'] for c in calls], ['final_review', 'integration_repair', 'final_review'])
        self.assertNotEqual(calls[0]['pid'], calls[-1]['pid'])
        self.assertNotIn('Missing fix.txt', json.dumps(calls[-1]['request']['evidence']))
        self.assertTrue((Path(report['repositories']['app']['worktree']) / 'fix.txt').exists())
        self.assertFalse((self.f.repo / 'fix.txt').exists())
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_interrupted_failed_checks_still_receive_initial_review(self):
        self.f.plan['checks'][0]['argv'][-1] = "from pathlib import Path; assert Path('fix.txt').exists()"
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        with patch.object(factory_v2.Session, 'worker', side_effect=OSError('review dispatch interrupted')):
            value = owner.run()
        self.assertEqual(value['status'], 'incomplete')
        self.assertEqual(self.f.calls(), [])
        code, value = self.cli('continue', self.report)
        self.assertEqual(code, 0, value)
        self.assertEqual([c['phase'] for c in self.f.calls()],
                         ['final_review', 'integration_repair', 'final_review'])
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_report_only_findings_and_stale_evidence(self):
        self.configure(findings=True)
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        self.assertEqual(value['status'], 'reviewed')
        self.assertEqual(report['final_review']['issues'], ['Missing fix.txt'])
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])
        self.assertEqual(self.cli('complete', self.report)[1]['status'], 'reviewed')
        self.assertEqual(self.cli('continue', self.report)[1]['status'], 'reviewed')
        self.assertTrue(all(c['phase'] == 'final_review' for c in self.f.calls()))
        Path(report['final_checks'][0]['stdout']).write_text('changed evidence')
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'stale')

    def test_report_only_mutating_check_never_edits_source(self):
        self.f.plan['checks'][0]['argv'][-1] = "from pathlib import Path; Path('existing.txt').write_text('bad')"
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review(only=True)
        self.assertNotEqual(code, 0, value)
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual(report['final_checks'][0]['status'], 'source_changed')
        self.assertEqual(self.f.calls(), [])
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)

    def test_no_progress_cannot_retry_to_pass(self):
        (self.f.repo / 'dirty.txt').write_text('existing dirt')
        self.configure(findings=True, no_progress=True)
        code, value, report = self.review()
        self.assertNotEqual(code, 0, value)
        self.assertIn('no source progress', value['reason'])
        calls = len(self.f.calls())
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertEqual(len(self.f.calls()), calls)

    def assert_deleted_input_noop_is_durably_incomplete(self):
        # A second review would report clean even though the repair made no edit.
        self.f.fake.write_text(self.f.fake.read_text().replace(
            "if control.get('findings') and 'review' in phase and not all((p/'fix.txt').exists() for p in paths.values()):",
            "if control.get('findings') and 'review' in phase and "
            "sum('review' in json.loads(line)['phase'] for line in (root / 'calls.jsonl').read_text().splitlines()) == 1:"))
        self.configure(findings=True, no_progress=True)
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review()
        self.assertNotEqual(code, 0, value)
        self.assertEqual(value['status'], 'incomplete')
        self.assertIn('no source progress', value['reason'])
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual([c['phase'] for c in self.f.calls()],
                         ['final_review', 'integration_repair'])
        saved = json.loads((self.output / 'final' / 'report.json').read_text())
        self.assertTrue(saved['integration_no_progress_stop'])
        for _ in range(2):
            code, value = self.cli('continue', self.report)
            self.assertNotEqual(code, 0, value)
            self.assertEqual(value['status'], 'incomplete')
            self.assertIn('no source progress', value['reason'])
        self.assertEqual(len(self.f.calls()), 2)
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'incomplete')

    def test_unstaged_tracked_deletion_noop_cannot_reach_lucky_clean_review(self):
        doomed = self.f.repo / 'doomed.txt'
        doomed.write_text('tracked content')
        self.f.git(self.f.repo, 'add', '.')
        self.f.git(self.f.repo, 'commit', '-qm', 'existing tracked work')
        doomed.unlink()
        self.assert_deleted_input_noop_is_durably_incomplete()

    def test_deleted_intent_to_add_noop_cannot_reach_lucky_clean_review(self):
        doomed = self.f.repo / 'doomed.txt'
        doomed.write_text('pending content')
        self.f.git(self.f.repo, 'add', '-N', '.')
        doomed.unlink()
        (self.f.repo / 'dirty.txt').write_text('existing dirt to commit')
        self.assert_deleted_input_noop_is_durably_incomplete()

    def test_unstaged_deletion_with_actual_repair_reaches_fresh_review(self):
        doomed = self.f.repo / 'doomed.txt'
        doomed.write_text('tracked content')
        self.f.git(self.f.repo, 'add', '.')
        self.f.git(self.f.repo, 'commit', '-qm', 'existing tracked work')
        doomed.unlink()
        self.configure(findings=True)
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review()
        self.assertEqual(code, 0, value)
        self.assertEqual([c['phase'] for c in self.f.calls()],
                         ['final_review', 'integration_repair', 'final_review'])
        copy = Path(report['repositories']['app']['worktree'])
        self.assertFalse((copy / 'doomed.txt').exists())
        self.assertEqual((copy / 'fix.txt').read_text(), 'x')
        self.assertEqual(factory.snapshot(self.f.repo), before)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_report_only_failed_checks_are_reported_and_never_repaired(self):
        self.f.plan['checks'][0]['argv'][-1] = "raise SystemExit(7)"
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        completion = self.cli('complete', self.report)[1]
        self.assertEqual(completion['status'], 'reviewed')
        self.assertFalse(completion['verified'])
        self.assertEqual(completion['check_failures'], ['contents'])
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])

    def test_report_only_reviewer_mutation_is_durably_incomplete(self):
        self.configure(mutate_review=True)
        before = factory.snapshot(self.f.repo)
        code, value, report = self.review(only=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(factory.snapshot(self.f.repo), before)
        calls = len(self.f.calls())
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertEqual(len(self.f.calls()), calls)
        self.assertNotEqual(self.cli('adopt', self.report, '--reason', 'keep mutation')[0], 0)
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)

    def test_missing_spec_is_explicit_report_only_limitation(self):
        self.f.plan['spec'] = None
        self.f.plan['tickets'][0]['source'] = None
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.assertNotEqual(self.cli('validate', self.f.plan_path)[0], 0)
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        self.assertTrue(self.cli('complete', self.report)[1]['limitations'])
        self.assertTrue(self.f.calls()[0]['request']['limitations'])

    def test_baseline_requires_full_pinned_commit(self):
        self.f.plan['input']['baselines']['app'] = 'HEAD'
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.assertNotEqual(self.cli('register', self.f.plan_path, '--output-dir', self.output)[0], 0)
        self.assertEqual(self.f.calls(), [])

    def test_source_change_and_active_claim_reject_new_or_continued_run(self):
        self.register()
        self.assertNotEqual(self.cli('run', self.f.plan_path, '--output-dir', self.f.base / 'bypass')[0], 0)
        (self.f.repo / 'new.txt').write_text('late source edit')
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertEqual(self.f.calls(), [])
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'stale')
        self.assertEqual(self.cli('close', self.report, '--reason', 'replace agreement')[0], 0)

    def test_product_blocker_cannot_disappear_on_lucky_retry(self):
        self.f.plan['checks'][0]['argv'][-1] = "from pathlib import Path; assert Path('fix.txt').exists()"
        self.f.plan_path.write_text(json.dumps(self.f.plan))
        self.configure(pending=True)
        code, value, report = self.review()
        self.assertNotEqual(code, 0)
        self.assertEqual([c['phase'] for c in self.f.calls()], ['final_review'])
        calls = len(self.f.calls())
        self.configure()
        self.assertNotEqual(self.cli('continue', self.report)[0], 0)
        self.assertEqual(len(self.f.calls()), calls)

    def test_interrupted_dirty_seed_continues_same_run(self):
        (self.f.repo / 'dirty.txt').write_text('keep existing edits')
        self.register()
        owner = factory_v2.ControllerV2(self.f.plan_path, self.output, resume=True)
        copy = factory_v2.shutil.copy2
        def interrupt_copy(source, target):
            copy(source, target)
            raise OSError('copy interrupted')
        with patch.object(factory_v2.shutil, 'copy2', side_effect=interrupt_copy):
            value = owner.run()
        self.assertEqual(value['status'], 'incomplete')
        self.assertEqual(self.f.calls(), [])
        code, result = self.cli('continue', self.report)
        self.assertEqual(code, 0, result)
        self.assertEqual(json.loads(self.report.read_text())['run_id'], owner.run_id)
        self.assertEqual(self.cli('complete', self.report)[0], 0)

    def test_tampered_attempt_summary_is_stale(self):
        code, value, report = self.review(only=True)
        self.assertEqual(code, 0, value)
        report['integration_attempts'][0]['review']['summary'] = 'tampered summary'
        self.report.write_text(json.dumps(report))
        self.assertNotEqual(self.cli('complete', self.report)[0], 0)
        self.assertEqual(self.cli('status', self.report)[1]['status'], 'stale')
