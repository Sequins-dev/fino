import os, pty, fcntl, struct, termios, subprocess, select, time, re, threading
FINO = os.environ.get('FINO_BIN', 'target/debug/fino')
APP = os.environ.get('FINO_APP', 'tests/tty/harness/sample-app.ts')
COLS, ROWS = int(os.environ.get('COLS', 100)), int(os.environ.get('ROWS', 24))

class Screen:
    """Cursor addressing, erase, and SGR tracking over a fixed-size grid."""

    def __init__(self, cols, rows, on_report=None):
        self.cols, self.rows = cols, rows
        self.cells = [[' '] * cols for _ in range(rows)]
        self.styles = [[''] * cols for _ in range(rows)]
        self.cx = self.cy = 0
        self.sgr = ''
        self.pending = ''
        # DECSTBM margins: apps pin a viewport by confining scrolling to the
        # rows above it, so history has to actually scroll to be testable.
        self.top = 0
        self.bottom = rows - 1
        self.saved = None
        self.scrolled = []
        # Modes on by default: 25 (cursor visible), 7 (DECAWM autowrap).
        self.modes = {7, 25}
        self.alt = False
        self.primary = None
        # DECAWM defers the wrap until the *next* printable char, so a write
        # that exactly fills a row leaves the cursor parked in the last column.
        self.wrap_pending = False
        # Answers back to the app (CPR); the driver wires this to the pty.
        self.on_report = on_report

    @property
    def autowrap(self):
        return 7 in self.modes
    @property
    def cursor_visible(self):
        return 25 in self.modes

    def feed(self, data):
        # A read can split an escape sequence; hold the tail until it completes
        # or it would be painted to the screen as literal text.
        data = self.pending + data
        self.pending = ''
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == '\x1b':
                if data[i:i+2] == '\x1b]':
                    end = data.find('\x07', i)
                    esc = data.find('\x1b\\', i)
                    if esc != -1 and (end == -1 or esc < end):
                        i = esc + 2
                    elif end != -1:
                        i = end + 1
                    else:
                        self.pending = data[i:]
                        return
                    continue
                m = re.match(r'\x1b\[([0-9;?]*)([A-Za-z])', data[i:])
                if not m:
                    if re.fullmatch(r'\x1b\[?[0-9;?]*', data[i:]):
                        self.pending = data[i:]
                        return
                    i += 1
                    continue
                params, cmd = m.group(1), m.group(2)
                if cmd == 'H':
                    parts = params.split(';') if params else []
                    cy = int(parts[0]) - 1 if len(parts) > 0 and parts[0] else 0
                    cx = int(parts[1]) - 1 if len(parts) > 1 and parts[1] else 0
                    self.move(cx, cy)
                elif cmd == 'J':
                    mode = int(params) if params.isdigit() else 0
                    if mode == 2:
                        self.cells = [[' '] * self.cols for _ in range(self.rows)]
                        self.styles = [[''] * self.cols for _ in range(self.rows)]
                    elif mode == 0:
                        if 0 <= self.cy < self.rows:
                            for x in range(self.cx, self.cols):
                                self.cells[self.cy][x] = ' '
                                self.styles[self.cy][x] = ''
                        for y in range(self.cy + 1, self.rows):
                            self.cells[y] = [' '] * self.cols
                            self.styles[y] = [''] * self.cols
                elif cmd == 'r':
                    parts = [p for p in params.split(';') if p] if params else []
                    self.top = int(parts[0]) - 1 if len(parts) > 0 else 0
                    self.bottom = int(parts[1]) - 1 if len(parts) > 1 else self.rows - 1
                elif cmd == 'K':
                    if 0 <= self.cy < self.rows:
                        for x in range(self.cx, self.cols):
                            self.cells[self.cy][x] = ' '
                            self.styles[self.cy][x] = ''
                elif cmd == 's':
                    self.saved = (self.cx, self.cy)
                elif cmd == 'u':
                    if self.saved:
                        self.move(*self.saved)
                elif cmd in ('h', 'l') and params.startswith('?'):
                    # Mouse and cursor modes are terminal-global; only 1049
                    # swaps the grid underneath them.
                    for p in params[1:].split(';'):
                        if not p:
                            continue
                        n = int(p)
                        if n == 1049:
                            self.set_alt(cmd == 'h')
                        if cmd == 'h':
                            self.modes.add(n)
                        else:
                            self.modes.discard(n)
                elif cmd == 'n' and params == '6':
                    # DSR: reply with the cursor as it stands right now, not as
                    # it will be once the rest of this buffer is drawn.
                    if self.on_report:
                        self.on_report(f'\x1b[{self.cy + 1};{self.cx + 1}R')
                elif cmd == 'm':
                    # Attributes accumulate until a reset, so a row painted
                    # inverse-then-underline reports both.
                    if params in ('', '0'):
                        self.sgr = ''
                    else:
                        self.sgr = ';'.join(filter(None, [self.sgr, params]))
                i += m.end()
                continue
            if ch == '\r':
                self.cx = 0; self.wrap_pending = False; i += 1; continue
            if ch == '\n':
                self.wrap_pending = False
                if self.cy >= self.bottom:
                    self.scroll_region()
                else:
                    self.cy += 1
                i += 1
                continue
            if self.wrap_pending and self.autowrap:
                self.wrap_pending = False
                self.cx = 0
                if self.cy >= self.bottom:
                    self.scroll_region()
                else:
                    self.cy += 1
            if 0 <= self.cy < self.rows and 0 <= self.cx < self.cols:
                self.cells[self.cy][self.cx] = ch
                self.styles[self.cy][self.cx] = self.sgr
            if self.cx >= self.cols - 1:
                # Autowrap off means the last column just keeps overprinting.
                self.wrap_pending = self.autowrap
            else:
                self.cx += 1
            i += 1
    def move(self, cx, cy):
        self.cx = max(0, min(cx, self.cols - 1))
        self.cy = max(0, min(cy, self.rows - 1))
        self.wrap_pending = False

    def set_alt(self, on):
        """Swap between the primary and alternate screen buffers."""
        if on == self.alt:
            return
        if on:
            self.primary = (self.cells, self.styles, self.cx, self.cy)
            self.cells = [[' '] * self.cols for _ in range(self.rows)]
            self.styles = [[''] * self.cols for _ in range(self.rows)]
            self.cx = self.cy = 0
        elif self.primary:
            self.cells, self.styles, self.cx, self.cy = self.primary
            self.primary = None
        self.alt = on
        self.top, self.bottom = 0, self.rows - 1
        self.wrap_pending = False

    def resize(self, cols, rows, anchor='cursor'):
        """Resize without reflow, anchored the way a terminal anchors.

        Shrinking the height scrolls content up rather than dropping the
        bottom rows, so rows that fall off the top enter scrollback -- which
        is what real emulators do, and what moves an app's bottom-pinned
        viewport up into its own history. How far they scroll varies, so both
        ends of the range are available: 'cursor' scrolls only far enough to
        keep the cursor on screen, 'bottom' always scrolls by the full height
        difference.
        """
        shed = 0
        if rows < self.rows:
            if anchor == 'bottom':
                shed = min(self.rows - rows, self.rows)
            elif self.cy > rows - 1:
                shed = min(self.cy - (rows - 1), self.rows)
            for y in range(shed):
                if not self.alt:
                    self.scrolled.append(''.join(self.cells[y]).rstrip())
            self.cells = self.cells[shed:]
            self.styles = self.styles[shed:]
        self.cols, self.rows = cols, rows
        self.cells = self._fit(self.cells, ' ')
        self.styles = self._fit(self.styles, '')
        if self.primary:
            cells, styles, cx, cy = self.primary
            self.primary = (self._fit(cells, ' '), self._fit(styles, ''),
                            min(cx, cols - 1), min(cy, rows - 1))
        self.cx, self.cy = min(self.cx, cols - 1), min(self.cy - shed, rows - 1)
        self.top = min(self.top, rows - 1)
        self.bottom = min(self.bottom, rows - 1)
        if self.bottom < self.top:
            self.top, self.bottom = 0, rows - 1
        self.wrap_pending = False
    def _fit(self, grid, blank):
        out = [(row + [blank] * self.cols)[:self.cols] for row in grid[:self.rows]]
        out += [[blank] * self.cols for _ in range(self.rows - len(out))]
        return out

    def scroll_region(self):
        """Shift the scrolling region up one row, as a terminal would."""
        if not self.alt:
            self.scrolled.append(''.join(self.cells[self.top]).rstrip())
        for y in range(self.top, self.bottom):
            self.cells[y] = self.cells[y + 1]
            self.styles[y] = self.styles[y + 1]
        self.cells[self.bottom] = [' '] * self.cols
        self.styles[self.bottom] = [''] * self.cols

    def scrollback(self):
        """Lines that scrolled off the top — the terminal's own history."""
        return self.scrolled

    def line(self, row):
        return ''.join(self.cells[row]).rstrip()
    def styled_spans(self, row):
        out, cur, cur_sgr = [], '', None
        for x in range(self.cols):
            sgr = self.styles[row][x]
            if sgr != cur_sgr:
                if cur.strip(): out.append((cur, cur_sgr))
                cur, cur_sgr = '', sgr
            cur += self.cells[row][x]
        if cur.strip(): out.append((cur, cur_sgr))
        return out
    def dump(self):
        return '\n'.join(self.line(r) for r in range(self.rows))

class Tui:
    def __init__(self, cols=COLS, rows=ROWS, app=APP):
        self.cols, self.rows = cols, rows
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        def ctty():
            os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.proc = subprocess.Popen([FINO, app], stdin=slave, stdout=slave, stderr=slave,
                                     close_fds=True, preexec_fn=ctty)
        os.close(slave)
        self.screen = Screen(cols, rows, on_report=self._report)
        self.raw = b''
        self.lock = threading.Lock()
        self.stop = False
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
    def _report(self, data):
        try: os.write(self.master, data.encode())
        except OSError: pass
    def _reader(self):
        while not self.stop:
            r, _, _ = select.select([self.master], [], [], 0.05)
            if r:
                try: c = os.read(self.master, 65536)
                except OSError: return
                if not c: return
                with self.lock:
                    self.raw += c
                    self.screen.feed(c.decode('utf-8', 'replace'))
    def wait(self, sec=0.4):
        time.sleep(sec)

    def wait_ready(self, timeout=10.0, marker=None):
        """Block until the app has painted its status bar.

        Sending input before raw mode is entered makes the terminal echo it
        onto the screen, which reads as a corrupted frame; waiting for real
        output instead of a fixed sleep removes that race.

        An inline app's footer sits against its content rather than on the
        last row, so any painted row counts; `marker` narrows that to a
        string the status bar is known to carry.
        """
        end = time.time() + timeout
        while time.time() < end:
            rows = [self.screen.line(i) for i in range(self.rows)]
            if marker is not None:
                if any(marker in row for row in rows):
                    return True
            elif any(row.strip() for row in rows):
                return True
            time.sleep(0.05)
        raise AssertionError('app did not paint a status bar')
    def send(self, data, settle=0.35):
        os.write(self.master, data.encode()); self.wait(settle)
    def resize(self, cols, rows, settle=0.35, anchor='cursor'):
        """Resize the pty; the kernel raises SIGWINCH in the app itself."""
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        with self.lock:
            self.cols, self.rows = cols, rows
            self.screen.resize(cols, rows, anchor)
        self.wait(settle)
    def mouse(self, code, x, y, release=False, settle=0.2):
        self.send(f'\x1b[<{code};{x + 1};{y + 1}{"m" if release else "M"}', settle)
    def sweep(self, points, code=35, delay=0.008):
        for (x, y) in points:
            os.write(self.master, f'\x1b[<{code};{x+1};{y+1}M'.encode())
            time.sleep(delay)
    def close(self):
        self.stop = True
        try: self.proc.kill()
        except Exception: pass

if __name__ == '__main__':
    checks = []
    def ok(name, cond):
        checks.append((name, cond))
        print(('ok   ' if cond else 'FAIL ') + name)

    # 1. CPR responds with the cursor position at the moment 6n is parsed.
    out = []
    s = Screen(20, 5, on_report=out.append)
    s.feed('\x1b[3;5H\x1b[6nxx')
    ok('CPR reports 1-based position', out == ['\x1b[3;5R'])
    out.clear()
    s = Screen(20, 5, on_report=out.append)
    s.feed('ab\x1b[6ncd\x1b[6n')
    ok('CPR tracks cursor mid-stream', out == ['\x1b[1;3R', '\x1b[1;5R'])
    out.clear()
    s = Screen(80, 24, on_report=out.append)
    s.feed('\x1b[s\x1b[9999;9999H\x1b[6n\x1b[u')  # how tui.ts probes for size
    ok('CPR answers the size probe', out == ['\x1b[24;80R'] and (s.cx, s.cy) == (0, 0))

    # 2. CSI J parameters.
    s = Screen(6, 4)
    s.feed('aaaaaa\r\nbbbbbb\r\ncccccc\r\ndddddd')
    s.feed('\x1b[2;3H\x1b[J')
    ok('0J erases to end of screen',
       [s.line(r) for r in range(4)] == ['aaaaaa', 'bb', '', ''])
    s = Screen(6, 2)
    s.feed('aaaaaa\r\nbbbbbb\x1b[1;1H\x1b[1J')
    ok('1J is a no-op', [s.line(r) for r in range(2)] == ['aaaaaa', 'bbbbbb'])
    s.feed('\x1b[2J')
    ok('2J clears everything', s.dump().strip() == '')

    # 3. Alternate screen buffer.
    s = Screen(8, 3)
    s.feed('main\r\nline2\x1b[2;3H')
    s.feed('\x1b[?1049h')
    ok('alt starts blank', s.dump().strip() == '' and (s.cx, s.cy) == (0, 0))
    s.feed('alt\n')
    ok('alt scroll skips scrollback', s.scrollback() == [])
    s.feed('\x1b[?1049l')
    ok('primary restored', [s.line(r) for r in range(3)] == ['main', 'line2', ''])
    ok('primary cursor restored', (s.cx, s.cy) == (2, 1))
    s.feed('\x1b[3;1H\n')
    ok('primary keeps its scrollback', s.scrollback() == ['main'])

    # 4. Private mode tracking.
    s = Screen(8, 3)
    ok('cursor visible by default', s.cursor_visible and s.autowrap)
    s.feed('\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h')
    ok('mode 25 off hides cursor', not s.cursor_visible)
    ok('mouse modes tracked', {1000, 1002, 1006} <= s.modes)
    s.feed('\x1b[?1049h')
    ok('modes survive buffer swap', {1000, 1006, 1049} <= s.modes and not s.cursor_visible)
    s.feed('\x1b[?1049l\x1b[?25h\x1b[?1000l')
    ok('modes clear on l', s.cursor_visible and 1000 not in s.modes and 1049 not in s.modes)
    s.feed('\x1b[?7l')
    ok('autowrap disabled', not s.autowrap)

    # 5. DECAWM pending wrap.
    s = Screen(5, 3)
    s.feed('abcde')
    ok('filling a row parks the cursor', (s.cx, s.cy) == (4, 0) and s.wrap_pending)
    s.feed('f')
    ok('next char wraps', [s.line(r) for r in range(3)] == ['abcde', 'f', ''])
    s = Screen(5, 2)
    s.feed('abcde\rx')
    ok('CR clears pending wrap', s.line(0) == 'xbcde' and s.line(1) == '')
    s = Screen(5, 2)
    s.feed('abcde\ny')  # LF keeps the column, so the wrap must not also fire
    ok('LF clears pending wrap', s.line(0) == 'abcde' and s.line(1) == '    y')
    s = Screen(5, 2)
    s.feed('abcde\x1b[1;1Hz')
    ok('addressing clears pending wrap', s.line(0) == 'zbcde')
    s = Screen(5, 2)
    s.feed('\x1b[?7labcdef')
    ok('no autowrap overprints last column', s.line(0) == 'abcdf' and s.line(1) == '')
    s = Screen(4, 4)
    s.feed('\x1b[1;3r\x1b[3;1Hwxyz')  # region rows 1-3, cursor on the last one
    s.feed('q')
    ok('wrap at bottom margin scrolls region',
       s.scrollback() == [''] and s.line(1) == 'wxyz' and s.line(2) == 'q')

    # 6. Resize: no reflow, and shrinking keeps the cursor on screen.
    s = Screen(6, 3)
    s.feed('abcdef\r\nghijkl\r\nmnopqr\x1b[1;5H')  # cursor on the first row
    s.resize(4, 2)
    ok('resize crops when the cursor survives', [s.line(r) for r in range(2)] == ['abcd', 'ghij'])
    s = Screen(6, 3)
    s.feed('abcdef\r\nghijkl\r\nmnopqr\x1b[1;5H')
    s.resize(4, 2, anchor='bottom')
    ok('bottom anchor always scrolls', [s.line(r) for r in range(2)] == ['ghij', 'mnop'])
    s = Screen(6, 3)
    s.feed('abcdef\r\nghijkl\r\nmnopqr\x1b[3;5H')  # cursor on the row being cut
    s.resize(4, 2)
    ok('resize scrolls to keep the cursor', [s.line(r) for r in range(2)] == ['ghij', 'mnop'])
    ok('rows shed on resize enter scrollback', s.scrollback() == ['abcdef'])
    ok('resize clamps cursor and margins',
       (s.cx, s.cy) == (3, 1) and (s.top, s.bottom) == (0, 1))
    s.resize(6, 4)
    ok('resize pads', [s.line(r) for r in range(4)] == ['ghij', 'mnop', '', ''])
    s.feed('\x1b[4;1HZZ')
    ok('grid usable after resize', s.line(3) == 'ZZ')
    try:
        m, sl = pty.openpty()
        fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 34, 0, 0))
        r, c, _, _ = struct.unpack('HHHH', fcntl.ioctl(sl, termios.TIOCGWINSZ, b'\0' * 8))
        os.close(m); os.close(sl)
        ok('TIOCSWINSZ round-trips', (r, c) == (12, 34))
    except OSError as e:
        print('skip TIOCSWINSZ round-trip:', e)

    # Regressions: pre-existing behaviour must still hold.
    s = Screen(10, 4)
    s.feed('\x1b[1;2r')
    s.feed('one\r\ntwo\r\nthree\r\n')
    ok('region scroll + scrollback', s.scrollback() == ['one', 'two'])
    s = Screen(10, 2)
    s.feed('\x1b[7mhot\x1b[0m cold')
    ok('styled_spans', s.styled_spans(0) == [('hot', '7'), (' cold  ', '')])
    s = Screen(10, 2)
    s.feed('\x1b[1;')
    s.feed('3Hx')
    ok('split escape buffered', s.line(0) == '  x' and s.pending == '')
    s = Screen(10, 2)
    s.feed('\x1b]0;title\x07hi\x1b[1;1H\x1b[K')
    ok('OSC skipped + CSI K', s.line(0) == '')
    s = Screen(10, 2)
    s.feed('ab\x1b[scd\x1b[uZ')
    ok('save/restore cursor', s.line(0) == 'abZd')

    bad = [n for n, c in checks if not c]
    print(f'\n{len(checks) - len(bad)}/{len(checks)} passed')
    raise SystemExit(1 if bad else 0)
