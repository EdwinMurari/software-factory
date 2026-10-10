#!/usr/bin/env python3
"""Write disposable v2 examples with a deterministic worker (no model or service)."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from factory import digest

WORKER = '''import json, pathlib, sys
r = json.load(sys.stdin)
if r['phase'] == 'investigate':
    print(json.dumps({'summary': 'Read actual demo source', 'points': [
        {'id': p['id'], 'disposition': 'confirmed',
         'evidence': ['existing.txt contains demo source'], 'questions': []}
        for p in r['points']]}))
else:
    if r['phase'] in ('implement', 'repair', 'integration_repair'):
        for root in r['repositories'].values():
            pathlib.Path(root, 'saved.txt').write_text('saved\\n')
    ok = all(pathlib.Path(root, 'saved.txt').read_text() == 'saved\\n' for root in r['repositories'].values())
    print(json.dumps({'status': 'complete' if ok else 'blocked', 'summary': 'Checked saved.txt', 'issues': [],
        'acceptance': [{'id': a['id'], 'status': 'verified' if ok else 'pending',
                        'evidence': 'Read saved.txt from every participating worktree'} for a in r['acceptance']]}))
'''


def create(directory):
    directory = directory.resolve()
    directory.mkdir()
    repo = directory / 'source'
    repo.mkdir()
    for args in (['init', '-q'], ['config', 'user.name', 'Factory Demo'],
                 ['config', 'user.email', 'demo@example.invalid']):
        subprocess.run(['git', '-C', str(repo), *args], check=True)
    (repo / 'existing.txt').write_text('demo source\n')
    subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(repo), 'commit', '-qm', 'Initial demo source'], check=True)
    spec = directory / 'spec.md'
    spec.write_text('Example outcome: write saved.txt with saved followed by a newline. This fixture is not a user approval record.\n')
    ref = {'path': str(spec), 'sha256': digest(spec.read_bytes())}
    worker = directory / 'worker.py'
    worker.write_text(WORKER)
    common = {'version': 2, 'repositories': {'app': str(repo)},
              'worker': {'kind': 'custom', 'argv': [sys.executable, str(worker)]},
              'worker_timeout_seconds': 30, 'run_timeout_seconds': 120}
    build = {**common, 'input': {'kind': 'outcome', 'description': 'Persist demo content'},
             'spec': ref, 'decisions': [], 'max_workers': 2,
             'checks': [{'id': 'saved', 'repo': 'app', 'argv': [sys.executable, '-c',
                        "from pathlib import Path; assert Path('saved.txt').read_text() == 'saved\\n'"]}],
             'tickets': [{'id': 'save', 'prompt': 'Implement the demo outcome in spec.md',
                          'source': ref, 'decision_ids': [], 'repos': ['app'], 'depends_on': [], 'checks': ['saved'],
                          'acceptance': [{'id': 'saved-content', 'description': 'saved.txt contains saved and a newline'}]}],
             'integration_checks': ['saved']}
    audit = {**common, 'input': {'kind': 'audit', 'points': [
        {'id': 'missing-save', 'description': 'Source has no saved.txt', 'sources': [ref]}]}}
    (directory / 'build.json').write_text(json.dumps(build, indent=2))
    (directory / 'audit.json').write_text(json.dumps(audit, indent=2))
    print(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='New directory, outside any source repository')
    create(parser.parse_args().directory)
