import { describe, it } from 'fino:test/test';
import {
  EMPTY_STYLE,
  applySgr,
  colorEquals,
  internStyle,
  mergeStyle,
  styleEquals,
  styleToSgr,
} from 'fino:tty/style';
import { charWidth, stringWidth, graphemes, clusterWidth } from 'internal:tty/width';

describe('fino:tty/style', () => {
  it('pins the named palette to its SGR codes', (t) => {
    const foreground: Array<[string, number]> = [
      ['black', 30],
      ['red', 31],
      ['green', 32],
      ['yellow', 33],
      ['blue', 34],
      ['magenta', 35],
      ['cyan', 36],
      ['white', 37],
      ['brightBlack', 90],
      ['brightRed', 91],
      ['brightGreen', 92],
      ['brightYellow', 93],
      ['brightBlue', 94],
      ['brightMagenta', 95],
      ['brightCyan', 96],
      ['brightWhite', 97],
    ];
    for (const [name, code] of foreground) {
      t.equal(
        styleToSgr(EMPTY_STYLE, { fg: name as never }),
        `\x1b[${code}m`,
        `${name} fg is SGR ${code}`,
      );
      t.equal(
        styleToSgr(EMPTY_STYLE, { bg: name as never }),
        `\x1b[${code + 10}m`,
        `${name} bg is SGR ${code + 10}`,
      );
    }
  });

  it('interns styles to canonical pointers', (t) => {
    const a = internStyle({ fg: 'cyan', bold: true });
    const b = internStyle({ bold: true, fg: 'cyan' });
    const c = internStyle({ fg: 'cyan', bold: true, dim: false });
    t.equal(a, b, 'field order does not matter');
    t.equal(a, c, 'false attributes normalize to absent');
    t.ok(a !== internStyle({ fg: 'cyan' }), 'different appearance, different pointer');
    t.equal(internStyle({}), EMPTY_STYLE, 'empty interns to EMPTY_STYLE');
  });

  it('compares styles and colors structurally', (t) => {
    t.ok(styleEquals({ fg: { rgb: [1, 2, 3] } }, { fg: { rgb: [1, 2, 3] } }), 'rgb equality');
    t.ok(!styleEquals({ fg: { rgb: [1, 2, 3] } }, { fg: { rgb: [1, 2, 4] } }), 'rgb inequality');
    t.ok(colorEquals({ ansi256: 12 }, { ansi256: 12 }), 'indexed equality');
    t.ok(!colorEquals('red', 'green'), 'named inequality');
  });

  it('merges with inherit-by-absence and disable-by-false', (t) => {
    const base = internStyle({ fg: 'cyan', bold: true, underline: true });
    const merged = mergeStyle(base, { bold: false, bg: 'blue' });
    t.equal(merged, internStyle({ fg: 'cyan', underline: true, bg: 'blue' }), 'false disables');
    t.equal(mergeStyle(base, {}), base, 'empty overlay inherits everything');
  });

  it('emits minimal SGR transitions', (t) => {
    const bold = internStyle({ bold: true });
    const boldRed = internStyle({ bold: true, fg: 'red' });
    t.equal(styleToSgr(bold, boldRed), '\x1b[31m', 'only the color changes');
    t.equal(styleToSgr(boldRed, bold), '\x1b[39m', 'color returns to default');
    t.equal(styleToSgr(bold, bold), '', 'no change, no bytes');
    t.equal(styleToSgr(boldRed, EMPTY_STYLE), '\x1b[0m', 'to default is a bare reset');
    t.equal(
      styleToSgr(internStyle({ bold: true, dim: true }), internStyle({ dim: true })),
      '\x1b[22;2m',
      'bold off shares 22 with dim, so dim is re-applied',
    );
    t.equal(
      styleToSgr(internStyle({ underline: true }), internStyle({ inverse: true })),
      '\x1b[24;7m',
      'independent attributes toggle individually',
    );
    t.equal(
      styleToSgr(EMPTY_STYLE, { fg: { ansi256: 208 } }),
      '\x1b[38;5;208m',
      '256-color foreground',
    );
    t.equal(
      styleToSgr(EMPTY_STYLE, { bg: { rgb: [10, 20, 30] } }),
      '\x1b[48;2;10;20;30m',
      'truecolor background',
    );
  });

  it('applies SGR parameter lists', (t) => {
    let style = applySgr(EMPTY_STYLE, [1, 33]);
    t.equal(style, internStyle({ bold: true, fg: 'yellow' }), 'bold yellow');
    style = applySgr(style, [22]);
    t.equal(style, internStyle({ fg: 'yellow' }), '22 clears bold and dim');
    style = applySgr(style, [48, 5, 17, 4]);
    t.equal(
      style,
      internStyle({ fg: 'yellow', bg: { ansi256: 17 }, underline: true }),
      'extended color params consume their arguments',
    );
    style = applySgr(style, [0]);
    t.equal(style, EMPTY_STYLE, '0 resets');
    style = applySgr(EMPTY_STYLE, [38, 2, 1, 2, 3]);
    t.equal(style, internStyle({ fg: { rgb: [1, 2, 3] } }), 'truecolor fg');
    t.equal(applySgr(EMPTY_STYLE, [5, 8, 73]), EMPTY_STYLE, 'unknown params are ignored');
  });
});

describe('internal:tty/width', () => {
  it('measures character widths', (t) => {
    t.equal(charWidth(0x61), 1, 'ascii is narrow');
    t.equal(charWidth(0x65e5), 2, 'CJK is wide');
    t.equal(charWidth(0x3042), 2, 'hiragana is wide');
    t.equal(charWidth(0x0301), 0, 'combining accent is zero');
    t.equal(charWidth(0x200d), 0, 'ZWJ is zero');
    t.equal(charWidth(0x1f600), 2, 'emoji is wide');
    t.equal(charWidth(0xff21), 2, 'fullwidth latin is wide');
  });

  it('measures string widths', (t) => {
    t.equal(stringWidth('hello'), 5, 'plain ascii');
    t.equal(stringWidth('日本'), 4, 'wide chars count two');
    t.equal(stringWidth('café'), 4, 'combining accent adds nothing');
    t.equal(stringWidth(''), 0, 'empty');
    t.equal(stringWidth('a日b'), 4, 'mixed');
  });

  it('segments graphemes and measures clusters', (t) => {
    t.deepEqual(graphemes('ab'), ['a', 'b'], 'plain split');
    t.deepEqual(graphemes('éx'), ['é', 'x'], 'combining stays attached');
    t.equal(clusterWidth('é'), 1, 'accented cluster is one cell');
    t.equal(clusterWidth('日'), 2, 'wide cluster is two cells');
    t.equal(clusterWidth('❤️'), 2, 'VS16 forces emoji presentation width');
  });
});
