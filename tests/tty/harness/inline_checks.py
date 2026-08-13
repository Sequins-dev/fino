"""End-to-end PTY checks for the inline `fino code` TUI.

Run from the repo root after `cargo build`:

    python3 tests/tty/harness/inline_checks.py

Each scenario drives the real TUI (via sample-app.ts and a scripted model)
through a PTY and asserts on the emulated screen, the captured scrollback,
and the raw byte stream. Exits non-zero when any check fails.
"""

import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_driver import Tui  # noqa: E402

FAILURES = []


def check(cond, label):
    print(('PASS' if cond else 'FAIL'), label)
    if not cond:
        FAILURES.append(label)


def spawn(**envs):
    os.environ['FINO_BIN'] = './target/debug/fino'
    os.environ['FINO_APP'] = 'tests/tty/harness/sample-app.ts'
    os.environ['COLS'] = '80'
    os.environ['ROWS'] = '24'
    for key in ('HARNESS_DELAY_MS', 'HARNESS_SUBAGENTS', 'HARNESS_MODELS', 'HARNESS_APPROVAL'):
        os.environ.pop(key, None)
    for key, value in envs.items():
        os.environ[key] = value
    t = Tui()
    t.wait_ready(20)
    return t


def alltext(t):
    return '\n'.join(t.screen.scrollback() + [t.screen.line(i) for i in range(24)])


def quit_app(t):
    t.send('/exit', settle=0.1)
    t.send('\r', settle=0.8)
    t.close()


def scenario_chat_basics():
    print('--- chat basics ---')
    t = spawn(HARNESS_DELAY_MS='10')
    raw_head = t.raw.decode('utf-8', 'replace')
    check(not any(s in raw_head for s in ('\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003h')),
          'no mouse capture in chat')
    check(1049 not in t.screen.modes, 'primary buffer, not alt screen')
    check(t.screen.cursor_visible, 'terminal cursor visible')
    t.send('hello there', settle=0.2)
    t.send('\r', settle=0.5)
    time.sleep(3.0)
    text = alltext(t)
    check('❯ hello there' in text, 'user block committed')
    check('Closing prose after the code block.' in text, 'assistant markdown committed')
    check(re.search(r'✔ \d+s', text), 'turn marker committed')
    t.send('/mo', settle=0.3)
    check('/model' in t.screen.dump(), 'slash selector opens')
    t.send('\x15', settle=0.2)
    quit_app(t)


def scenario_model_picker():
    print('--- model picker overlay ---')
    t = spawn(HARNESS_DELAY_MS='5', HARNESS_MODELS='6')
    t.send('/model', settle=0.2)
    t.send('\r', settle=0.8)
    check(1049 in t.screen.modes, 'picker enters alt screen')
    check(any(m in t.screen.modes for m in (1000, 1002, 1006)), 'mouse capture on in picker')
    check('model-00' in t.screen.dump(), 'catalog listed')
    t.send('\x1b', settle=0.8)
    check(1049 not in t.screen.modes, 'picker closes back to inline')
    check(not any(m in t.screen.modes for m in (1000, 1002, 1003, 1006)),
          'mouse capture off after picker')
    quit_app(t)


def scenario_approval():
    print('--- approval band ---')
    t = spawn(HARNESS_DELAY_MS='10', HARNESS_APPROVAL='1')
    t.send('write it', settle=0.3)
    t.send('\r', settle=1.5)
    d = t.screen.dump()
    check('approval required' in d, 'approval band appears')
    check('write_file' in d, 'band names the tool')
    t.send('zz', settle=0.2)
    check('❯ zz' not in t.screen.dump(), 'composer locked during approval')
    t.send('y', settle=1.0)
    time.sleep(2.5)
    check('✔ approved write_file' in alltext(t), 'decision record committed')
    quit_app(t)


def scenario_subagents():
    print('--- sub-agents ---')
    t = spawn(HARNESS_DELAY_MS='10', HARNESS_SUBAGENTS='2')
    t.send('fan out', settle=0.3)
    t.send('\r', settle=1.0)
    time.sleep(6.0)
    check('subagent_spawn' in alltext(t), 'spawn calls committed')
    check('2 agents' in t.screen.line(23), 'agents segment in status bar')
    t.send('\x07', settle=0.5)
    check('worker-1' in t.screen.dump(), 'agent selector lists children')
    t.send('\x1b[B', settle=0.2)
    t.send('\r', settle=1.0)
    check('agent: worker-1' in t.screen.line(23), 'child view focused')
    check('research part 1' in alltext(t), 'child task replayed')
    check('ask, or /help' not in t.screen.dump(), 'composer hidden on child view')
    t.send('\t', settle=0.8)
    t.send('\t', settle=0.8)
    check('ask, or /help' in t.screen.dump(), 'tab cycles back to main')
    quit_app(t)


def scenario_steer():
    print('--- queue and steer ---')
    t = spawn(HARNESS_DELAY_MS='200')
    t.send('slow one', settle=0.2)
    t.send('\r', settle=0.4)
    t.send('queued msg', settle=0.2)
    t.send('\r', settle=0.3)
    check('queued msg' in t.screen.dump(), 'message queues while busy')
    t.send('\x13', settle=0.5)
    time.sleep(6.0)
    check('steered: queued msg' in alltext(t), 'steer notice committed')
    quit_app(t)


def scenario_session_manager():
    print('--- session manager ---')
    t = spawn(HARNESS_DELAY_MS='5')
    t.send('name my session please', settle=0.2)
    t.send('\r', settle=0.5)
    time.sleep(2.5)
    t.send('\x02', settle=0.8)
    check(1049 in t.screen.modes, 'manager enters alt screen')
    check('name my session please' in t.screen.dump(), 'session card shows derived title')
    t.send('\x1b[B', settle=0.3)
    t.send('r', settle=0.3)
    t.send('\x15', settle=0.2)
    t.send('renamed one', settle=0.3)
    t.send('\r', settle=0.6)
    check('renamed one' in t.screen.dump(), 'inline rename applied')
    t.send('a', settle=0.8)
    check('archived (1)' in t.screen.dump(), 'archive collapses the session')
    t.send('\x1b[B', settle=0.3)
    t.send('\r', settle=0.5)
    t.send('\x1b[B', settle=0.3)
    t.send('\r', settle=1.2)
    check('ARCHIVED' in t.screen.line(23), 'archived view is read-only')
    quit_app(t)


def scenario_attention_dots():
    print('--- attention dots ---')
    t = spawn(HARNESS_DELAY_MS='600')
    t.send('hi a', settle=0.2)
    t.send('\r', settle=0.5)
    time.sleep(12.0)
    t.send('\x02', settle=0.6)
    t.send('n', settle=1.0)
    t.send('hi b', settle=0.2)
    t.send('\r', settle=0.6)
    t.send('\x0e', settle=1.2)
    check('● · · ·' in t.screen.line(23), 'busy dot lit while background session works')
    time.sleep(12.0)
    check('· · · ●' in t.screen.line(23), 'done dot lit for unseen result')
    t.send('\x0e', settle=1.5)
    time.sleep(0.5)
    check('●' not in t.screen.line(23), 'dots clear when the session is seen')
    quit_app(t)


SCENARIOS = [
    scenario_chat_basics,
    scenario_model_picker,
    scenario_approval,
    scenario_subagents,
    scenario_steer,
    scenario_session_manager,
    scenario_attention_dots,
]

if __name__ == '__main__':
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for scenario in SCENARIOS:
        if only and only not in scenario.__name__:
            continue
        scenario()
    if FAILURES:
        print(f'{len(FAILURES)} check(s) failed')
        sys.exit(1)
    print('all inline checks passed')
