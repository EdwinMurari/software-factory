"""Persistent v2 entry, continuation and exact-state completion gates.

These are local evidence records and advisory locks, not authenticated attestations.
Execution stays in ControllerV2 and the shared Controller verification loop.
"""
from pathlib import Path
import fcntl
import os

from factory import FactoryError, Controller, digest, encoded, git, now, read_json, snapshot, text, validate_result, repository_lock_path
from factory_audit import references_unchanged


def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(encoded(value))
    temporary.replace(path)


def registry_paths(owner):
    from factory_v2 import common_directory
    return sorted({common_directory(p) / 'software-factory-active.json' for p in owner.sources.values()})


def claim_run(owner):
    if owner.report.get('status') == 'closed':
        raise FactoryError('Run is closed; register a new approved plan')
    paths = registry_paths(owner)
    for path in paths:
        if path.exists():
            record = read_json(path)
            if record['run_id'] != owner.run_id and record['state'] not in ('complete', 'closed'):
                raise FactoryError('Existing active run: ' + record['report'] + '; continue that report instead of choosing a new output directory')
    owner.report['registry_paths'] = [str(path) for path in paths]
    owner.report['lock_paths'] = [str(path) for path in sorted({repository_lock_path(root) for root in owner.sources.values()})]
    for path in paths:
        atomic(path, {'run_id': owner.run_id, 'report': str(owner.output / 'report.json'), 'state': 'active'})


def finish_claim(owner):
    if owner.investigate:
        return
    for path in registry_paths(owner):
        atomic(path, {'run_id': owner.run_id, 'report': str(owner.output / 'report.json'),
                      'state': 'complete' if owner.report['status'] == 'verified' else 'active'})


def known_worktrees(report):
    records = list(report['repositories'].values())
    for state in report['tickets'].values():
        records.extend(state.get('repositories', state.get('setup', {}).get('repositories', {})).values())
    records.extend(r for r in report.get('worktree_setups', []) if Path(r['worktree']).exists())
    return {r['worktree'] for r in records}


def retained_inputs(owner, checkpoints=False):
    """Use the last persisted process checkpoint when finalization was interrupted."""
    observed = {} if checkpoints or owner.report.get('operation_open') else dict(owner.report.get('observed_worktree_inputs', {}))
    for tid, state in owner.report['tickets'].items():
        setup = state.get('setup', {})
        records = state.get('repositories', setup.get('repositories', {}))
        session_path = owner.output / 'tasks' / tid / 'report.json'
        if records and session_path.exists():
            session = read_json(session_path)
            for name, record in records.items():
                observed.setdefault(record['worktree'], session['observed_inputs'][name])
        else:
            for name, record in records.items():
                observed.setdefault(record['worktree'], setup.get('adopted_inputs', setup['inputs'])[name])
    final_path = owner.output / 'final' / 'report.json'
    final = read_json(final_path) if final_path.exists() else {}
    for name, record in owner.report['repositories'].items():
        root = Path(record['worktree'])
        if ((checkpoints or owner.report.get('operation_open')) and record.get('head')
                and git(root, 'rev-parse', 'HEAD').decode().strip() == record['head']
                and not git(root, 'status', '--porcelain', '--untracked-files=all')):
            observed.setdefault(str(root), snapshot(root))
        observed.setdefault(record['worktree'], final.get('observed_inputs', {}).get(name, owner.source_inputs[name]))
    for index, adoption in enumerate(owner.report.get('adoptions', []), 1):
        if adoption.get('status') == 'pending':
            for path, change in adoption['changes'].items():
                observed[path] = owner.report.get('observed_worktree_inputs', {}).get(path, change['after'])
            commit_path = owner.output / 'adoptions' / str(index) / 'commit' / 'report.json'
            if (checkpoints or owner.report.get('operation_open')) and commit_path.exists():
                commit = read_json(commit_path)
                for name, value in commit.get('observed_inputs', {}).items():
                    observed[str(owner.integration[name])] = value
    for setup in owner.report.get('worktree_setups', []):
        if Path(setup['worktree']).exists():
            observed.setdefault(setup['worktree'], setup.get('adopted_inputs', setup['base_inputs']))
    return observed


def require_workers_stopped(output):
    session_paths = [output / 'final' / 'report.json']
    for pattern in ('tasks/*/report.json', 'setup/*/*/report.json', 'adoptions/*/commit/report.json'):
        session_paths.extend(output.glob(pattern))
    for session_path in session_paths:
        if not session_path.exists():
            continue
        for process in read_json(session_path).get('processes', []):
            if process['status'] == 'incomplete' and process.get('pid'):
                try:
                    os.kill(process['pid'], 0)
                except ProcessLookupError:
                    pass
                else:
                    raise FactoryError('An interrupted worker may still be running (PID ' + str(process['pid']) + '); wait for its exit before continuation')


def finish_adoption(owner, adoption):
    """Resume a recorded adoption; incomplete captures and Git logs stay on disk."""
    from factory import capture_baseline
    from factory_v2 import Session
    directory = owner.output / 'adoptions' / str(owner.report['adoptions'].index(adoption) + 1)
    for number, (path, change) in enumerate(sorted(adoption['changes'].items())):
        if 'snapshot' in change:
            continue
        # A failed capture may have partial files. Allocate another capture instead
        # of overwriting that evidence or treating its presence as success.
        captures = change.setdefault('captures', [])
        output = directory / str(number) / str(len(captures) + 1)
        captures.append(str(output))
        owner.save()
        output.mkdir(parents=True)
        change['snapshot'] = capture_baseline(Path(path), output)
        owner.save()
    for setup in owner.report.get('worktree_setups', []):
        if setup['worktree'] in adoption['changes']:
            setup['adopted_inputs'] = adoption['changes'][setup['worktree']]['after']
            if setup['role'] == 'integration' and setup['repo'] not in owner.integration:
                owner.integration[setup['repo']] = Path(setup['worktree'])
                owner.report['repositories'][setup['repo']] = {key: setup[key] for key in ('branch', 'worktree', 'base_sha')}
    owner.save()
    for tid, state in owner.report['tickets'].items():
        records = state.get('repositories', state.get('setup', {}).get('repositories', {}))
        if any(r['worktree'] in adoption['changes'] for r in records.values()):
            state['status'] = 'incomplete'
            if 'setup' in state:
                state['setup']['adopted_inputs'] = {name: snapshot(Path(r['worktree'])) for name, r in records.items()}
            owner.save()
            session_path = owner.output / 'tasks' / tid / 'report.json'
            if session_path.exists():
                session = read_json(session_path)
                session['tickets'][tid]['status'] = 'incomplete'
                session['observed_inputs'] = {name: snapshot(Path(r['worktree'])) for name, r in records.items()}
                atomic(session_path, session)
    if any(p in adoption['changes'] for p in map(str, owner.integration.values())):
        session = Session(owner, owner.integration, directory / 'commit', [], {}).restore()
        session.commit_all('Factory adopt: ' + adoption['reason'])
        for name, root in owner.integration.items():
            owner.report['repositories'][name]['head'] = git(root, 'rev-parse', 'HEAD').decode().strip()
    adoption['status'] = 'complete'
    owner.save()


def prepare_operation(owner, action, reason, findings):
    if owner.investigate:
        return
    if owner.resuming:
        references_unchanged(owner.report['dependencies'] + owner.report.get('evidence_files', []))
        require_workers_stopped(owner.output)
        pending = next((a for a in owner.report.get('adoptions', []) if a.get('status') == 'pending'), None)
        expected = retained_inputs(owner)
        actual = {p: snapshot(Path(p)) for p in known_worktrees(owner.report)}
        changed = {p: {'before': expected.get(p), 'after': value} for p, value in actual.items() if value != expected.get(p)}
        if changed and action != 'adopt':
            raise FactoryError('Unaccounted worktree edits; use adopt REPORT --reason TEXT to record retained edits and rerun checks and fresh review')
        if pending and changed:
            raise FactoryError('Pending adoption inputs changed; preserve the new edits and restore the recorded inputs before retrying adoption')
        if action == 'adopt':
            text(reason, 'adoption reason')
            if not changed and not pending:
                raise FactoryError('No unaccounted worktree edits to adopt')
        values = None
        if action == 'reopen':
            values = read_json(findings)
            if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
                raise FactoryError('Findings must be a nonempty JSON array of concrete issue strings')
        history = owner.output / 'history'
        history.mkdir(exist_ok=True)
        atomic(history / (str(len(owner.report.get('operations', []))) + '.json'), read_json(owner.output / 'report.json'))
        # Persist ownership before changing evidence files or source. A failed
        # capture, report edit or commit must leave a retryable operation.
        owner.report.pop('evidence_files', None)
        owner.report['operation_open'] = True
        owner.report.setdefault('operations', []).append({'action': action, 'at_aest': now()})
        owner.report['status'] = 'incomplete'
        owner.report.pop('reason', None)
        if action == 'adopt' and not pending:
            pending = {'at_aest': now(), 'reason': reason, 'changes': changed, 'status': 'pending'}
            owner.report.setdefault('adoptions', []).append(pending)
            owner.report['observed_worktree_inputs'] = actual
        if values:
            owner.report.setdefault('findings', []).append({'at_aest': now(), 'issues': values,
                                                          'source_sha256': digest(Path(findings).read_bytes()), 'resolved': False})
        owner.save()
        owner.operation_ready = True
        if pending:
            finish_adoption(owner, pending)
    else:
        owner.report['operations'] = [{'action': 'register', 'at_aest': now()}]
        owner.save()


def validate_verification(session, plan, tickets, expected_inputs=None):
    """Check coverage, process evidence, exact input binding and zero findings."""
    required = set(plan['integration_checks']) | {c for t in tickets for c in t['checks']}
    checks = session['final_checks']
    if not isinstance(checks, list) or len(checks) != len(required) or {c['check_id'] for c in checks} != required:
        raise FactoryError('Missing or duplicate required check evidence')
    check_map = {c['id']: c for c in plan['checks']}
    processes = session['processes']
    fingerprint = expected_inputs or checks[0]['inputs_sha256']
    for check in checks:
        for field in ('stdout', 'stderr'):
            Path(check[field]).read_bytes()
        definition = check_map[check['check_id']]
        if (check['status'] != 'passed' or check['exit_code'] != 0
                or check['argv'] != definition['argv'] or check['repo'] != definition['repo']
                or check['inputs_sha256'] != fingerprint or check['after_inputs_sha256'] != fingerprint):
            raise FactoryError('Failed or stale required check evidence')
        if not any(all(p.get(k) == check.get(k) for k in ('argv', 'phase', 'stdout', 'stderr', 'inputs_sha256', 'after_inputs_sha256', 'status', 'exit_code')) for p in processes):
            raise FactoryError('Required check process evidence missing')
    review = validate_result(session['final_review'], [a['id'] for t in tickets for a in t['acceptance']])
    if not Controller.review_complete(review):
        raise FactoryError('Review has unresolved findings or pending acceptance')
    reviews = [p for p in processes if p['phase'] == 'final_review' and p.get('result') == review]
    if reviews:
        for field in ('stdout', 'stderr'):
            Path(reviews[-1][field]).read_bytes()
    if not reviews or reviews[-1]['status'] != 'passed' or reviews[-1]['exit_code'] != 0 or any(reviews[-1][key] != fingerprint for key in ('inputs_sha256', 'after_inputs_sha256')):
        raise FactoryError('Fresh final review process evidence missing')


def complete(path):
    from factory_v2 import load_plan, controller_hash, repository_inputs
    path = Path(path).resolve()
    report = read_json(path)
    if report['version'] != 2 or report['mode'] != 'build':
        raise FactoryError('Completion requires a v2 build report')
    plan, sources, plan_hash, _ = load_plan(Path(report['plan_path']))
    if plan_hash != report['plan_sha256'] or controller_hash() != report['controller_sha256']:
        raise FactoryError('Plan or controller changed')
    if report['dependencies'] != plan['_dependencies']:
        raise FactoryError('Dependency evidence missing or changed')
    if plan['_intake']['blockers'] or plan['_intake']['global_blockers'] or any(plan['_intake']['task_blockers'].values()):
        raise FactoryError('Unresolved intake or product decisions')
    if repository_inputs(sources) != report['source_inputs'] or plan['_source_branches'] != report['source_branches']:
        raise FactoryError('Starting source checkout changed; restore the approved input before continuing')
    if set(report['repositories']) != set(sources) or set(report['tickets']) != {t['id'] for t in plan['tickets']}:
        raise FactoryError('Missing repository or ticket evidence')
    worktrees = known_worktrees(report)
    if set(report['observed_worktree_inputs']) != worktrees:
        raise FactoryError('Missing worktree observations')
    if any(snapshot(Path(p)) != report['observed_worktree_inputs'][p] for p in worktrees):
        raise FactoryError('Unaccounted worktree edits; adopt retained edits before completion')
    manifests = report['evidence_files']
    if not isinstance(manifests, list) or not manifests:
        raise FactoryError('Missing evidence manifest')
    # Every retained session and log is required, rather than trusting an empty manifest.
    expected_files = {str(p) for folder in ('tasks', 'final', 'setup', 'original-baselines', 'adoptions', 'history')
                      for p in (path.parent / folder).rglob('*') if p.is_file()}
    if {r['path'] for r in manifests} != expected_files:
        raise FactoryError('Incomplete evidence manifest')
    references_unchanged(plan['_dependencies'] + manifests)
    for ticket in plan['tickets']:
        state = report['tickets'][ticket['id']]
        if state['status'] != 'integrated':
            raise FactoryError('Task is not integrated: ' + ticket['id'])
        session = read_json(path.parent / 'tasks' / ticket['id'] / 'report.json')
        task_inputs = repository_inputs({n: Path(r['worktree']) for n, r in state['repositories'].items()})
        validate_verification(session, dict(plan, integration_checks=ticket['checks']), [ticket], digest(encoded(task_inputs)))
        for name, record in state['repositories'].items():
            head = git(Path(record['worktree']), 'rev-parse', 'HEAD').decode().strip()
            # Recorded task commits must remain ancestors of the actual result.
            git(Path(report['repositories'][name]['worktree']), 'merge-base', '--is-ancestor', head, 'HEAD')
    integration = {n: Path(r['worktree']) for n, r in report['repositories'].items()}
    exact = repository_inputs(integration)
    if exact != report['final_inputs']:
        raise FactoryError('Integration changed after validation')
    final = read_json(path.parent / 'final' / 'report.json')
    validate_verification(final, plan, plan['tickets'], digest(encoded(exact)))
    if report['final_checks'] != final['final_checks'] or report['final_review'] != final['final_review']:
        raise FactoryError('Final evidence differs from saved session')
    if any(a.get('status') == 'pending' for a in report.get('adoptions', [])):
        raise FactoryError('Unfinished adoption; continue its retained operation')
    if any(not f['resolved'] for f in report.get('findings', [])):
        raise FactoryError('Unresolved late findings')
    if report['status'] != 'verified':
        raise FactoryError('Run has not reached completion')
    return {'status': 'verified', 'fresh': True, 'run_id': report['run_id'], 'report': str(path), 'claim': report['claim']}


def close_run(path, reason):
    """Explicitly end ownership without certifying or discarding incomplete work."""
    text(reason, 'closure reason')
    report = read_json(path)
    if report.get('version') != 2 or report.get('mode') != 'build':
        raise FactoryError('Closing requires a v2 build report')
    lock_paths = [Path(value) for value in report['lock_paths']]
    claims = [Path(value) for value in report['registry_paths']]
    streams = []
    try:
        for lock in [path.parent / '.operation.lock', *sorted(lock_paths)]:
            stream = lock.open('a+b')
            streams.append(stream)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise FactoryError('Another lifecycle operation holds repository lock: ' + str(lock)) from exc
        report = read_json(path)
        require_workers_stopped(path.parent)
        if report['status'] != 'closed':
            history = path.parent / 'history'
            history.mkdir(exist_ok=True)
            archive = history / ('closed-' + str(len(list(history.iterdir()))) + '.json')
            atomic(archive, report)
            report['closure'] = {'at_aest': now(), 'reason': reason, 'previous_status': report['status'],
                                 'previous_report': str(archive), 'previous_report_sha256': digest(archive.read_bytes())}
            report['status'] = 'closed'
            atomic(path, report)
        # Never release a newer run's claim when closing an older report.
        for registry in claims:
            if registry.exists():
                claim = read_json(registry)
                if claim['run_id'] == report['run_id'] and claim['report'] == str(path):
                    atomic(registry, dict(claim, state='closed'))
        return {'status': 'closed', 'verified': False, 'run_id': report['run_id'], 'report': str(path)}
    finally:
        for stream in streams:
            stream.close()


def operate(path, action, reason=None, findings=None):
    from factory_v2 import ControllerV2
    path = Path(path).resolve()
    if action == 'close':
        return close_run(path, reason)
    report = read_json(path)
    if report.get('version') != 2 or report.get('mode') != 'build':
        raise FactoryError('Lifecycle operations require a v2 build report')
    if report['status'] == 'closed':
        raise FactoryError('Run is closed; register a new approved plan')
    owner = ControllerV2(report['plan_path'], path.parent, resume=True)
    if action == 'complete':
        try:
            owner.acquire()
            result = complete(path)
            finish_claim(owner)
            return result
        finally:
            for stream in owner.locks:
                fcntl.flock(stream, fcntl.LOCK_UN)
                stream.close()
    result = owner.run(action, reason, findings)
    return {'status': result['status'], 'reason': result.get('reason'), 'run_id': owner.run_id, 'report': str(path)}
