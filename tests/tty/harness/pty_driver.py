import os, pty, fcntl, struct, termios, subprocess, select, time, re, threading
FINO = os.environ.get('FINO_BIN', 'target/debug/fino')
APP = os.environ.get('FINO_APP', 'tests/tty/harness/sample-app.ts')
COLS, ROWS = int(os.environ.get('COLS', 100)), int(os.environ.get('ROWS', 24))

class Screen:
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
                if data[i:i+2] == '\x1b]':
                    end = data.find('\x07', i)
                    esc = data.find('\x1b\\', i)
                    if esc != -1 and (end == -1 or esc < end):
                        i = esc + 2
                    elif end != -1:
                        i = end + 1
                    else:
                        i = len(data)
                    continue
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
        self.screen = Screen(cols, rows)
        self.raw = b''
        self.lock = threading.Lock()
        self.stop = False
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
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
    def send(self, data, settle=0.35):
        os.write(self.master, data.encode()); self.wait(settle)
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
