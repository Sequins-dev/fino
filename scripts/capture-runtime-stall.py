#!/usr/bin/env python3
"""Preserve live runtime snapshots and native stacks for a long-running test.

Run beside FINO_TRACE_DIRECTORY recording, with ptrace permission on Linux.
This observer never adds timers or wake notifications to the target runtime.
GDB does pause the target while attached; its wall time is recorded below.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--test-pattern', default='.')
parser.add_argument('--after', type=float, default=15)
parser.add_argument('--limit', type=int, default=8)
args = parser.parse_args()
pattern = re.compile(args.test_pattern)
seen = {}
first_stats = {}


def read_proc(path):
    try:
        return Path(path).read_text()
    except OSError as error:
        return str(error)


captured = set()
count = 0
while count < args.limit:
    for path in args.directory.glob('readiness-*.json'):
        try:
            snapshot = json.loads(path.read_text())
            pid = snapshot['pid']
        except (OSError, ValueError, KeyError):
            continue
        for owner, realm in snapshot.get('realms', {}).items():
            try:
                test = json.loads(realm.get('observations', {}).get('test', '{}'))
            except ValueError:
                continue
            if test.get('stage') != 'running' or not pattern.search(test.get('specifier', '')):
                continue
            key = (pid, owner, test.get('specifier'), test.get('name'))
            started = seen.setdefault(key, time.monotonic())
            if key not in first_stats:
                first_stats[key] = read_proc(f'/proc/{pid}/stat')
            if key in captured or time.monotonic() - started < args.after:
                continue
            captured.add(key)
            count += 1
            prefix = args.directory / f'stall-{count}-{pid}-{owner}'
            prefix.with_suffix('.json').write_text(json.dumps(snapshot))
            with prefix.with_suffix('.txt').open('w') as output:
                output.write(json.dumps({'pid': pid, 'owner': owner, 'test': test,
                                         'firstProcessStat': first_stats[key]}) + '\n')
                for source in [f'/proc/{pid}/stat', f'/proc/{pid}/status', f'/proc/{pid}/io',
                               '/proc/meminfo', '/proc/pressure/cpu', '/proc/pressure/memory',
                               '/proc/pressure/io', '/sys/fs/cgroup/memory.max',
                               '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.events']:
                    output.write(f'\n{source}\n{read_proc(source)}\n')
                output.flush()
                debugger_started = time.monotonic()
                try:
                    subprocess.run(['gdb', '--batch', '-nx', '-p', str(pid),
                                    '-ex', 'set pagination off',
                                    '-ex', 'thread apply all bt 25',
                                    '-ex', 'detach'], stdout=output, stderr=subprocess.STDOUT,
                                   timeout=15, check=False)
                except (OSError, subprocess.TimeoutExpired) as error:
                    output.write(str(error) + '\n')
                finally:
                    output.write(json.dumps({'debuggerWallSeconds': time.monotonic() - debugger_started}) + '\n')
            if count >= args.limit:
                break
    time.sleep(2)
