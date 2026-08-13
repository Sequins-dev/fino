"""Drive the real fino code TUI under a PTY and capture painted frames.

Renders the terminal by replaying the app's cursor-positioned writes into a
virtual screen, so we can assert on what the user would actually see.
"""
import os, pty, fcntl, struct, termios, subprocess, select, time, re, sys

FINO = '/Users/stephenbelanger/.t3/worktrees/fino/t3code-7bb0f500/target/debug/fino'
APP = '/tmp/tui-harness/app.ts'
COLS, ROWS = 100, 24

class Screen:
    """Minimal terminal emulator: cursor addressing + erase + SGR passthrough."""
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.cells = [[' '] * cols for _ in range(rows)]
        self.styles = [[''] * cols for _ in range(rows)]
        self.cx = self.cy = 0
        self.sgr = ''

    def feed(self, data):
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == '\x1b':
                m = re.match(r'\x1b\[([0-9;?]*)([A-Za-z])', data[i:])
                if not m:
                    i += 1
                    continue
                params, cmd = m.group(1), m.group(2)
                if cmd == 'H':
                    parts = params.split(';') if params else []
                    self.cy = int(parts[0]) - 1 if len(parts) > 0 and parts[0] else 0
                    self.cx = int(parts[1]) - 1 if len(parts) > 1 and parts[1] else 0
                elif cmd == 'J':
                    self.cells = [[' '] * self.cols for _ in range(self.rows)]
                    self.styles = [[''] * self.cols for _ in range(self.rows)]
                elif cmd == 'm':
                    self.sgr = '' if params in ('', '0') else params
                i += m.end()
                continue
            if ch == '\r':
                self.cx = 0; i += 1; continue
            if ch == '\n':
                self.cy += 1; i += 1; continue
            if 0 <= self.cy < self.rows and 0 <= self.cx < self.cols:
                self.cells[self.cy][self.cx] = ch
                self.styles[self.cy][self.cx] = self.sgr
            self.cx += 1
            i += 1

    def line(self, row):
        return ''.join(self.cells[row]).rstrip()

    def styled_spans(self, row):
        """Return [(text, sgr)] runs for a row, for asserting on styling."""
        out, cur, cur_sgr = [], '', None
        for x in range(self.cols):
            sgr = self.styles[row][x]
            if sgr != cur_sgr:
                if cur.strip():
                    out.append((cur, cur_sgr))
                cur, cur_sgr = '', sgr
            cur += self.cells[row][x]
        if cur.strip():
            out.append((cur, cur_sgr))
        return out

    def dump(self):
        return '\n'.join(self.line(r) for r in range(self.rows))


class Tui:
    def __init__(self):
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        def ctty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.proc = subprocess.Popen(
            [FINO, APP], stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, preexec_fn=ctty)
        os.close(slave)
        self.screen = Screen(COLS, ROWS)

    def pump(self, seconds=0.6):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.screen.feed(chunk.decode('utf-8', 'replace'))

    def send(self, data):
        os.write(self.master, data.encode())
        self.pump(0.35)

    def mouse(self, code, x, y, release=False):
        # SGR: ESC [ < code ; col ; row (M press / m release), 1-based coords
        self.send(f'\x1b[<{code};{x + 1};{y + 1}{"m" if release else "M"}')

    def close(self):
        try:
            self.send('\x03')
            self.proc.kill()
        except Exception:
            pass


if __name__ == '__main__':
    t = Tui()
    t.pump(2.0)
    print('=== initial frame ===')
    print(t.screen.dump())
    status_row = ROWS - 1
    print('\n=== status bar (no hover) ===')
    print(repr(t.screen.styled_spans(status_row)))

    # Hover the sidebar-toggle glyph at column 0 of the status bar.
    t.mouse(35, 0, status_row)
    print('\n=== status bar (hover col 0) ===')
    print(repr(t.screen.styled_spans(status_row)))

    # Hover the model name segment.
    line = t.screen.line(status_row)
    idx = line.find('harness-model')
    print('model segment index:', idx)
    if idx >= 0:
        t.mouse(35, idx + 2, status_row)
        print('\n=== status bar (hover model) ===')
        print(repr(t.screen.styled_spans(status_row)))
    t.close()
