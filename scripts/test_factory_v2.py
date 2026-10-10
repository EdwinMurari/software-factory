"""Executable regression scenarios for isolated builds and evidence-backed intake."""
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import factory
import factory_v2


FAKE = r'''
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
control = json.loads((root / 'control.json').read_text())
r = json.load(sys.stdin)
phase = r['phase']
tid = (r.get('ticket') or {}).get('id', 'all')
paths = {name: pathlib.Path(path) for name, path in r.get('repositories', {}).items()}
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps({'phase': phase, 'tid': tid, 'pid': os.getpid(), 'request': r}) + '\n')
if phase == 'investigate':
    if control.get('investigate_mutates'):
        (next(iter(paths.values())) / 'illegal.txt').write_text('changed')
    print(json.dumps({'summary': 'Actual inspection recorded', 'points': [
        {'id': p['id'], 'disposition': control.get('disposition', 'confirmed'),
         'evidence': ['existing.txt contains baseline; inspected actual source'],
         'questions': [{'id': 'choice-' + p['id'], 'question': 'Which approved behaviour?'}] if control.get('question') else []}
        for p in r['points']]}))
    sys.exit()
if phase == 'implement':
    (root / (tid + '.started')).write_text(str(os.getpid()))
    if control.get('overlap') and tid in ('a','b'):
        other = 'b' if tid == 'a' else 'a'
        deadline = time.monotonic() + 8
        while not (root / (other + '.started')).exists():
            if time.monotonic() > deadline: raise RuntimeError('No parallel overlap')
            time.sleep(.01)
        (root / (tid + '.overlap')).write_text('both implementation processes active')
    if tid == 'c':
        assert all((p / 'a.txt').exists() and (p / 'b.txt').exists() for p in paths.values())
    for path in paths.values():
        (path / (tid + '.txt')).write_text('persisted')
        if control.get('conflict') and tid in ('a','b'):
            (path / 'existing.txt').write_text(tid + '\n')
    if control.get('crash') == tid:
        sys.exit(13)
    if control.get('wait'):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        (root / (tid + '.child')).write_text(str(child.pid))
        time.sleep(60)
if phase == 'merger':
    for path in paths.values():
        (path / 'existing.txt').write_text('both approved changes\n')
        subprocess.run(['git','-C',str(path),'add','existing.txt'],check=True)
if phase in ('repair', 'integration_repair') and not control.get('no_progress'):
    for path in paths.values():
        p = path / 'fix.txt'
        p.write_text(p.read_text() + 'x' if p.exists() else 'x')
if control.get('mutate_review') and 'review' in phase:
    (next(iter(paths.values())) / 'illegal.txt').write_text('changed')
issues = []
status = 'complete'
if control.get('blocked') == tid and phase == 'implement': status = 'blocked'
if control.get('findings') and 'review' in phase and not all((p/'fix.txt').exists() for p in paths.values()):
    status = 'changes_requested'; issues = ['Missing fix.txt']
if control.get('pending') and 'review' in phase: status = 'blocked'
print(json.dumps({'status':status,'summary':'Observed persisted task content','issues':issues,
 'acceptance':[{'id':a['id'],'status':'pending' if control.get('pending') else 'verified',
 'evidence':'Inspected actual persisted files'} for a in r['acceptance']]}))
'''


class IsolatedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo = self.make_repo('source')
        self.fake = self.base / 'fake.py'
        self.fake.write_text(FAKE)
        self.control = self.base / 'control.json'
        self.control.write_text('{}')
        self.spec = self.base / 'spec.md'
        self.spec.write_text('User approved this product behaviour. Task pointers are here.')
        self.plan_path = self.base / 'plan.json'
        self.plan = {'version': 2, 'repositories': {'app': str(self.repo)},
                     'worker': {'kind': 'custom', 'argv': [sys.executable, str(self.fake), str(self.base)]},
                     'input': {'kind': 'outcome', 'description': 'Persist the approved files'},
                     'spec': self.ref(self.spec), 'decisions': [], 'max_workers': 2,
                     'checks': [{'id': 'contents', 'repo': 'app', 'argv': [sys.executable, '-c',
                                "from pathlib import Path; assert Path('existing.txt').is_file(); assert list(Path('.').glob('*.txt'))"]}],
                     'tickets': [self.ticket('a')], 'integration_checks': ['contents'],
                     'worker_timeout_seconds': 10, 'run_timeout_seconds': 40}

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, path, *args):
        return subprocess.run(['git', '-C', str(path), *args], check=True, capture_output=True).stdout

    def make_repo(self, name):
        path = self.base / name
        path.mkdir()
        self.git(path, 'init', '-q')
        self.git(path, 'config', 'user.name', 'Test')
        self.git(path, 'config', 'user.email', 'test@example.invalid')
        (path / 'existing.txt').write_text('baseline\n')
        self.git(path, 'add', '.')
        self.git(path, 'commit', '-qm', 'fixture')
        return path

    def ref(self, path):
        return {'path': str(path), 'sha256': factory.digest(path.read_bytes())}

    def ticket(self, tid, dependencies=(), repos=('app',), checks=('contents',)):
        return {'id': tid, 'prompt': 'Implement approved persisted content', 'depends_on': list(dependencies),
                'repos': list(repos), 'decision_ids': [], 'source': self.ref(self.spec),
                'checks': list(checks), 'acceptance': [{'id': tid + '-persisted', 'description': 'Content persists'}]}

    def config(self, **values):
        self.control.write_text(json.dumps(values))

    def run_factory(self, investigate=False, output='output'):
        self.plan_path.write_text(json.dumps(self.plan))
        c = factory_v2.ControllerV2(self.plan_path, self.base / output, investigate)
        return c, c.run()

    def calls(self):
        p = self.base / 'calls.jsonl'
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def test_clean_build_preserves_checkout_and_exact_final_evidence(self):
        before = factory.snapshot(self.repo)
        c, r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertEqual(factory.snapshot(self.repo), before)
        self.assertFalse((self.repo / 'a.txt').exists())
        integrated = Path(r['repositories']['app']['worktree'])
        self.assertTrue((integrated / 'a.txt').exists())
        self.assertEqual(r['final_checks'][0]['inputs_sha256'], factory.digest(factory.encoded(r['final_inputs'])))
        self.assertEqual(factory.report_status(c.output / 'report.json')['status'], 'verified')
        self.assertEqual(r['final_review']['issues'], [])
        (integrated / 'a.txt').write_text('late edit')
        self.assertEqual(factory.report_status(c.output / 'report.json')['status'], 'stale')

    def test_parallel_overlap_stable_batches_and_integrated_dependencies(self):
        self.plan['tickets'] = [self.ticket('c', ['a', 'b']), self.ticket('b'), self.ticket('a')]
        self.config(overlap=True)
        _, r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertTrue((self.base/'a.overlap').exists() and (self.base/'b.overlap').exists())
        self.assertEqual(r['batches'], [['a','b'], ['c']])
        self.assertEqual(r['integration_order'], ['a','b','c'])
        for tid in ('a','b','c'):
            self.assertEqual(r['tickets'][tid]['status'], 'integrated')
        calls = self.calls()
        pids = [x['pid'] for x in calls]
        self.assertEqual(len(set(pids)), len(pids))
        c = next(x for x in calls if x['tid'] == 'c' and x['phase'] == 'implement')
        bases = r['tickets']['c']['repositories']
        self.assertEqual(c['request']['integration_heads']['app'], bases['app']['base_sha'])

    def test_conflicts_dispatch_fresh_merger_and_recheck(self):
        self.plan['tickets'] = [self.ticket('a'), self.ticket('b')]
        self.config(conflict=True, overlap=True)
        _, r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertEqual((Path(r['repositories']['app']['worktree'])/'existing.txt').read_text(), 'both approved changes\n')
        calls = self.calls()
        merger = next(x for x in calls if x['phase'] == 'merger')
        self.assertIn('existing.txt', json.dumps(merger['request']['evidence']))
        self.assertTrue(any(x['phase'] == 'final_review' and x['tid'] == 'all' for x in calls[calls.index(merger)+1:]))

    def test_multiple_repositories_integrate_as_one_dependency(self):
        api = self.make_repo('api')
        self.plan['repositories']['api'] = str(api)
        self.plan['checks'].append({'id': 'api-content', 'repo': 'api', 'argv': [sys.executable, '-c',
                                                                 "from pathlib import Path; assert Path('a.txt').read_text() == 'persisted'"]})
        self.plan['tickets'] = [self.ticket('a', repos=('app','api'), checks=('contents','api-content')),
                                self.ticket('b', ['a'], repos=('app','api'), checks=('contents','api-content')),
                                self.ticket('c', ['b'], repos=('app','api'), checks=('contents','api-content'))]
        before = factory.snapshot(api)
        c,r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertEqual(factory.snapshot(api), before)
        self.assertEqual({x['repo'] for x in r['final_checks']}, {'api','app'})
        (api/'user-change.txt').write_text('uncommitted')
        self.assertEqual(factory.report_status(c.output/'report.json')['status'], 'stale')

    def test_dirty_build_rejected_without_dropping_edits(self):
        (self.repo/'user.txt').write_text('user edit')
        _,r = self.run_factory()
        self.assertEqual(r['status'], 'incomplete')
        self.assertIn('Dirty source', r['reason'])
        self.assertEqual((self.repo/'user.txt').read_text(), 'user edit')
        self.assertEqual(self.calls(), [])

    def test_blocked_task_stops_dependency_and_keeps_independent_result(self):
        self.plan['tickets'] = [self.ticket('a'),self.ticket('b'),self.ticket('c',['a'])]
        self.config(blocked='a')
        _,r = self.run_factory()
        self.assertEqual(r['status'], 'incomplete')
        self.assertEqual(r['tickets']['c']['status'], 'not_run')
        self.assertEqual(r['tickets']['b']['status'], 'integrated')
        a = Path(r['tickets']['a']['repositories']['app']['worktree'])
        self.assertTrue((a/'a.txt').exists())
        self.assertFalse(any(x['tid']=='c' for x in self.calls()))

    def test_default_repair_and_review_are_shared_and_fresh(self):
        self.config(findings=True)
        _,r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertEqual(len(r['tickets']['a']['attempts']), 2)
        for call in self.calls():
            if 'review' in call['phase']:
                self.assertNotIn('Missing fix.txt', json.dumps(call['request']))
        self.assertIn('Missing fix.txt', json.dumps(next(x for x in self.calls() if x['phase']=='repair')['request']['evidence']))

    def test_readonly_review_mutation_fails_and_preserves_edit(self):
        self.config(mutate_review=True)
        _,r = self.run_factory()
        self.assertEqual(r['status'], 'incomplete')
        self.assertTrue(any(p['status']=='source_changed' for p in r['tickets']['a']['processes']))
        self.assertTrue((Path(r['tickets']['a']['repositories']['app']['worktree'])/'illegal.txt').exists())

    def audit_plan(self):
        return {k: copy.deepcopy(self.plan[k]) for k in ('version','repositories','worker','worker_timeout_seconds','run_timeout_seconds')} | {
            'input': {'kind':'audit', 'points':[{'id':'p', 'description':'Saving loses content', 'sources':[self.ref(self.spec)]}]}}

    def test_fresh_investigation_includes_working_changes_and_requires_every_point(self):
        self.plan = self.audit_plan()
        (self.repo/'working.txt').write_text('working source')
        c,r = self.run_factory(investigate=True)
        self.assertEqual(r['status'], 'investigated', r.get('reason'))
        self.assertEqual(r['points'][0]['disposition'], 'confirmed')
        self.assertEqual([x['phase'] for x in self.calls()], ['investigate'])
        self.assertEqual(factory.report_status(c.output/'report.json')['status'], 'investigated')
        self.assertEqual(r['source_inputs']['app'], factory.snapshot(self.repo))
        (self.repo/'working.txt').write_text('stale')
        self.assertEqual(factory.report_status(c.output/'report.json')['status'], 'stale')

    def investigated_build(self, question=False):
        build = copy.deepcopy(self.plan)
        self.plan = self.audit_plan()
        self.config(question=question)
        c,r = self.run_factory(investigate=True, output='investigation')
        self.assertEqual(r['status'], 'investigated', r.get('reason'))
        audit_path = self.base / 'audit-plan.json'
        self.plan_path.rename(audit_path)
        report_path = c.output/'report.json'
        # Preserve the same external investigation plan path, as a coordinator would.
        data = json.loads(report_path.read_text()); data['plan_path'] = str(audit_path)
        report_path.write_text(json.dumps(data))
        self.plan = build
        self.plan['input'] = copy.deepcopy(data_input := json.loads(audit_path.read_text())['input'])
        self.plan['input'].update(investigation=self.ref(report_path), mappings=[{
            'point_id':'p','disposition':'implement','task_ids':['a'], 'decision_ids':['choice-p'] if question else []}])
        return report_path

    def test_audit_coverage_questions_deferral_and_freshness_gates(self):
        self.investigated_build(question=True)
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError, 'decision mapping'):
            factory_v2.load_plan(self.plan_path)
        decision_path = self.base/'decision.txt'
        decision_path.write_text('User: implement persisted content; defer point p if not building it.')
        self.plan['decisions'] = [{'id':'choice-p','status':'resolved','choice':'Persist content','reference':self.ref(decision_path)}]
        self.plan['tickets'][0]['decision_ids'] = ['choice-p']
        original = copy.deepcopy(self.plan)
        self.plan['input']['mappings'] = []
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError,'Every original'):
            factory_v2.load_plan(self.plan_path)
        self.plan = copy.deepcopy(original)
        self.plan['input']['mappings'][0].update(disposition='defer', task_ids=[], decision_ids=[])
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError,'questions lack'):
            factory_v2.load_plan(self.plan_path)
        self.plan = copy.deepcopy(original)
        _,r = self.run_factory(output='approved')
        self.assertEqual(r['status'],'verified',r.get('reason'))
        self.plan['decisions'][0] = {'id':'choice-p','status':'pending'}
        _,r = self.run_factory(output='pending')
        self.assertEqual(r['status'],'incomplete')
        self.assertIn('Unresolved product decision',r['reason'])
        self.plan = original
        (self.repo/'new-source.txt').write_text('stale')
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError,'fingerprint is stale'):
            factory_v2.load_plan(self.plan_path)

    def test_audit_implementation_requires_actual_decision_reference_even_without_questions(self):
        self.investigated_build()
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError, 'recorded resolved user decision'):
            factory_v2.load_plan(self.plan_path)

    def test_explicit_deferral_is_reported_and_unapproved_deferral_rejected(self):
        self.investigated_build(question=True)
        decision = self.base / 'user-choice.txt'
        decision.write_text('Test fixture user choice: defer p and implement the separately specified task a.')
        self.plan['decisions'] = [{'id': 'choice-p', 'status': 'resolved', 'choice': 'Defer p', 'reference': self.ref(decision)}]
        self.plan['input']['mappings'][0].update(disposition='defer', task_ids=[])
        _, r = self.run_factory(output='deferred')
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        self.assertEqual(r['intake']['deferrals'], ['p'])
        self.assertEqual(r['intake']['points'][0]['disposition'], 'defer')
        self.plan['decisions'][0] = {'id': 'choice-p', 'status': 'pending'}
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError, 'Deferral requires'):
            factory_v2.load_plan(self.plan_path)

    def test_group_investigations_are_fresh_and_cover_all_original_points(self):
        self.plan = self.audit_plan()
        self.plan['input']['points'] += [
            {'id': p, 'description': 'Investigate original point ' + p, 'sources': [self.ref(self.spec)]}
            for p in ('q', 'r')]
        self.plan['input']['groups'] = [{'id': 'save-group', 'point_ids': ['p', 'q'], 'reason': 'Same save path'}]
        _, r = self.run_factory(investigate=True)
        self.assertEqual(r['status'], 'investigated', r.get('reason'))
        self.assertEqual({p['id'] for p in r['points']}, {'p', 'q', 'r'})
        self.assertEqual(len(self.calls()), 2)
        self.assertNotEqual(self.calls()[0]['pid'], self.calls()[1]['pid'])
        self.plan['input']['groups'][0]['point_ids'].append('missing')
        self.plan_path.write_text(json.dumps(self.plan))
        with self.assertRaisesRegex(factory.FactoryError, 'Invalid or overlapping'):
            factory_v2.load_plan(self.plan_path, investigate=True)

    def test_decision_and_preserved_evidence_files_are_freshness_dependencies(self):
        decision = self.base / 'user-choice.txt'
        decision.write_text('Test fixture: persist the approved record')
        self.plan['decisions'] = [{'id': 'save', 'status': 'resolved', 'choice': 'Persist record', 'reference': self.ref(decision)}]
        self.plan['tickets'][0]['decision_ids'] = ['save']
        c, r = self.run_factory()
        self.assertEqual(r['status'], 'verified', r.get('reason'))
        log = Path(r['final_checks'][0]['stdout'])
        original = log.read_bytes()
        log.write_text('replaced evidence')
        self.assertEqual(factory.report_status(c.output / 'report.json')['status'], 'stale')
        log.write_bytes(original)
        decision.write_text('changed choice')
        self.assertEqual(factory.report_status(c.output / 'report.json')['status'], 'stale')

    def test_relative_audit_sources_are_sent_as_absolute_evidence_pointers(self):
        self.plan = self.audit_plan()
        self.plan['input']['points'][0]['sources'][0]['path'] = 'spec.md'
        _, r = self.run_factory(investigate=True)
        self.assertEqual(r['status'], 'investigated', r.get('reason'))
        sent = self.calls()[0]['request']['points'][0]['sources'][0]['path']
        self.assertTrue(Path(sent).is_absolute())
        self.assertEqual(sent, str(self.spec.resolve()))

    def test_no_progress_stops_without_implicit_attempt_cap(self):
        self.config(findings=True, no_progress=True)
        _, r = self.run_factory()
        self.assertEqual(r['status'], 'incomplete')
        self.assertIn('no source progress', r['reason'])
        self.assertEqual([c['phase'] for c in self.calls()], ['implement', 'review', 'repair'])

    def test_finalization_does_not_relabel_evidence_after_late_integration_change(self):
        self.plan_path.write_text(json.dumps(self.plan))
        c = factory_v2.ControllerV2(self.plan_path, self.base / 'output')
        original = factory_v2.repository_inputs
        changed = False
        verified_evidence = {}
        def concurrent_change(repositories):
            nonlocal changed
            if c.report['status'] == 'verified' and repositories == c.integration and not changed:
                verified_evidence.update({key: copy.deepcopy(c.report[key])
                                          for key in ('final_inputs', 'final_checks', 'final_review')})
                (next(iter(repositories.values())) / 'late-change.txt').write_text('changed after verification')
                changed = True
            return original(repositories)
        with patch.object(factory_v2, 'repository_inputs', concurrent_change):
            r = c.run()
        self.assertTrue(changed)
        self.assertEqual(r['status'], 'incomplete')
        self.assertIn('adopt', r['reason'])
        for key, value in verified_evidence.items():
            self.assertEqual(r[key], value, key)
        self.assertEqual((next(iter(c.integration.values())) / 'late-change.txt').read_text(),
                         'changed after verification')
        self.assertNotEqual(r['final_inputs'], original(c.integration))
        report_path = c.output / 'report.json'
        self.assertEqual(json.loads(report_path.read_text())['status'], 'incomplete')
        status = factory.report_status(report_path)
        self.assertEqual(status['status'], 'stale')
        self.assertFalse(status['fresh'])

    def test_worktree_from_same_repository_cannot_bypass_another_run_lock(self):
        linked = self.base / 'linked'
        self.git(self.repo, 'worktree', 'add', '-qb', 'linked', str(linked))
        self.assertEqual(factory.repository_lock_path(linked), factory.repository_lock_path(self.repo))

    def test_investigation_is_actually_readonly(self):
        self.plan = self.audit_plan()
        self.config(investigate_mutates=True)
        _,r = self.run_factory(investigate=True)
        self.assertEqual(r['status'],'incomplete')
        self.assertEqual(r['points'],[])
        self.assertTrue((self.repo/'illegal.txt').exists())

    def test_crash_preserves_worktree_and_never_runs_dependency(self):
        self.plan['tickets'] = [self.ticket('a'),self.ticket('b',['a'])]
        self.config(crash='a')
        _,r = self.run_factory()
        self.assertEqual(r['status'],'incomplete')
        self.assertEqual(r['tickets']['b']['status'],'not_run')
        self.assertTrue((Path(r['tickets']['a']['repositories']['app']['worktree'])/'a.txt').exists())

    def assert_stopped(self, pid):
        deadline = time.monotonic()+3
        while time.monotonic()<deadline:
            try: os.kill(pid,0)
            except ProcessLookupError: return
            status = Path(f'/proc/{pid}/stat')
            if status.exists() and status.read_text().split(') ',1)[1].startswith('Z'): return
            time.sleep(.02)
        self.fail(f'Process {pid} still active')

    def test_shared_deadline_kills_worker_descendants(self):
        self.config(wait=True)
        self.plan['worker_timeout_seconds'] = 30
        self.plan['run_timeout_seconds'] = 10
        _,r = self.run_factory()
        self.assertEqual(r['status'],'incomplete')
        self.assertTrue(any(p['status']=='timeout' for p in r['tickets']['a']['processes']))
        self.assert_stopped(int((self.base/'a.child').read_text()))

    def test_cancellation_has_one_cleanup_owner_and_preserves_checkpoint(self):
        self.config(wait=True)
        self.plan_path.write_text(json.dumps(self.plan))
        owner = factory_v2.ControllerV2(self.plan_path, self.base / 'output')

        def cancel_started_worker():
            deadline = time.monotonic() + 10
            while not (self.base / 'a.child').exists() and time.monotonic() < deadline:
                time.sleep(.02)
            owner.runtime.stop()

        canceller = threading.Thread(target=cancel_started_worker)
        with patch.object(factory_v2, 'kill_group', wraps=factory_v2.kill_group) as cleanup:
            canceller.start()
            try:
                result = owner.run()
            finally:
                canceller.join(timeout=12)
        self.assertFalse(canceller.is_alive())
        self.assertTrue((self.base / 'a.child').exists())
        self.assertEqual(result['status'], 'incomplete')
        worker_pid = int((self.base / 'a.started').read_text())
        self.assertEqual(sum(call.args[0].pid == worker_pid for call in cleanup.call_args_list), 1)
        task = Path(result['tickets']['a']['repositories']['app']['worktree'])
        self.assertEqual((task / 'a.txt').read_text(), 'persisted')
        self.assertEqual(result['observed_worktree_inputs'][str(task)], factory.snapshot(task))
        self.assert_stopped(int((self.base / 'a.child').read_text()))

    def test_cancel_parallel_workers_and_release_repository_locks(self):
        self.plan['tickets']=[self.ticket('a'),self.ticket('b')]
        self.config(wait=True,overlap=True)
        self.plan_path.write_text(json.dumps(self.plan))
        output=self.base/'output'
        proc=subprocess.Popen([sys.executable,str(Path(factory.__file__)),'run',str(self.plan_path),'--output-dir',str(output)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            end=time.monotonic()+10
            while not all((self.base/(t+'.child')).exists() for t in ('a','b')) and time.monotonic()<end:
                time.sleep(.02)
            self.assertTrue(all((self.base/(t+'.child')).exists() for t in ('a','b')))
            # A concurrent build must fail before dispatching or mutating worktrees.
            second=factory_v2.ControllerV2(self.plan_path,self.base/'second').run()
            self.assertEqual(second['status'],'incomplete')
            self.assertIn('repository lock',second['reason'])
            legacy = {'version': 1, 'project': str(self.repo), 'worker': self.plan['worker'],
                      'checks': [{k:v for k,v in check.items() if k != 'repo'} for check in self.plan['checks']],
                      'tickets': [{k:v for k,v in self.plan['tickets'][0].items() if k not in ('source','repos','decision_ids')}],
                      'integration_checks': ['contents']}
            legacy_path = self.base / 'legacy.json'
            legacy_path.write_text(json.dumps(legacy))
            legacy_report = factory.Controller(legacy_path, self.base / 'legacy-output').run()
            self.assertEqual(legacy_report['status'], 'incomplete')
            self.assertIn('repository lock', legacy_report['reason'])
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=8)
            r=json.loads((output/'report.json').read_text())
            self.assertEqual(r['status'],'incomplete')
            self.assertIn('SIGTERM',r['reason'])
            run_id = r['run_id']
            logs = {p: p.read_bytes() for p in (output / 'tasks').rglob('*.stderr')}
            for tid in ('a','b'):
                task = Path(r['tickets'][tid]['repositories']['app']['worktree'])
                self.assertEqual((task / (tid + '.txt')).read_text(), 'persisted')
                self.assertEqual(r['observed_worktree_inputs'][str(task)], factory.snapshot(task))
                self.assert_stopped(int((self.base/(tid+'.child')).read_text()))
            # Advisory locks are released while retained lock files prevent unlink races.
            self.config()
            from factory_lifecycle import operate
            r = operate(output / 'report.json', 'continue')
            self.assertEqual(r['status'],'verified',r.get('reason'))
            self.assertEqual(r['run_id'], run_id)
            for path, content in logs.items():
                self.assertEqual(path.read_bytes(), content)
        finally:
            if proc.poll() is None: proc.kill();proc.wait()


if __name__ == '__main__':
    unittest.main()
