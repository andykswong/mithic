import { expect, test, describe } from 'vitest';
import { wcCommand } from './wc.ts';
import { makeIO } from './_test-io.ts';

describe('wc', () => {
  test('default lines/words/bytes from stdin', async () => {
    const h = makeIO({ args: ['wc'], stdinText: 'one two\nthree\n' });
    expect(await wcCommand(h.io)).toBe(0);
    // 2 lines, 3 words, 14 bytes — stdin multi-field uses the width-7 floor
    expect(h.out()).toBe('      2       3      14\n');
  });

  test('-l only counts lines (single field, single source → no pad)', async () => {
    const h = makeIO({ args: ['wc', '-l'], stdinText: 'a\nb\nc\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('-w only counts words', async () => {
    const h = makeIO({ args: ['wc', '-w'], stdinText: 'a b  c\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('-c counts bytes, -m counts chars (multibyte)', async () => {
    const hc = makeIO({ args: ['wc', '-c'], stdinText: 'café\n' });
    expect(await wcCommand(hc.io)).toBe(0);
    expect(hc.out()).toBe('6\n'); // é = 2 bytes + 'caf' + newline = 6

    const hm = makeIO({ args: ['wc', '-m'], stdinText: 'café\n' });
    expect(await wcCommand(hm.io)).toBe(0);
    expect(hm.out()).toBe('5\n'); // 5 code points
  });

  test('reads file with name label', async () => {
    const h = makeIO({ args: ['wc', '-l', '/a'], files: { '/a': 'x\ny\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2 /a\n');
  });

  test('multiple files emit a total line', async () => {
    const h = makeIO({ args: ['wc', '-l', '/a', '/b'], files: { '/a': 'x\n', '/b': 'y\nz\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    // total bytes = 2+4 = 6 → width 1
    expect(h.out()).toBe('1 /a\n2 /b\n3 total\n');
  });

  test('empty input is all zeros', async () => {
    const h = makeIO({ args: ['wc'], stdinText: '' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      0       0       0\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['wc', '/missing'] });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.err()).toContain('wc: /missing:');
  });

  // ── dynamic field width (GNU parity) ────────────────────────────────────────

  test('single count, single source → no padding', async () => {
    const h = makeIO({ args: ['wc', '-l'], stdinText: 'a\nb\nc\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('single count, single file → no padding, space before label', async () => {
    const h = makeIO({ args: ['wc', '-l', '/f'], files: { '/f': 'a\nb\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2 /f\n');
  });

  test('multi field from stdin uses width-7 floor', async () => {
    const h = makeIO({ args: ['wc'], stdinText: 'one two\nthree\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2       3      14\n');
  });

  test('multi field, single file → width from total byte count', async () => {
    const h = makeIO({ args: ['wc', '/f'], files: { '/f': 'one two\nthree\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    // total bytes = 14 → 2 digits → width 2
    expect(h.out()).toBe(' 2  3 14 /f\n');
  });

  test('width derives from total byte count, not displayed field value', async () => {
    // line counts are 1,2,3 but total bytes 155 → 3-digit width
    const big = 'x'.repeat(150) + '\n';
    const h = makeIO({ args: ['wc', '-l', '/big', '/f2'], files: { '/big': big, '/f2': 'a\nb\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('  1 /big\n  2 /f2\n  3 total\n');
  });

  test('single field, multiple files pads to total-byte width', async () => {
    const h = makeIO({ args: ['wc', '-l', '/la', '/lb'], files: { '/la': 'abc\n', '/lb': 'abcdef\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    // total bytes = 4+7 = 11 → width 2
    expect(h.out()).toBe(' 1 /la\n 1 /lb\n 2 total\n');
  });

  test('explicit "-" operand keeps its label', async () => {
    const h = makeIO({ args: ['wc', '-l', '-', '/f5'], stdinText: 'a\nb\nc\n', files: { '/f5': 'a\nb\nc\nd\ne\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      3 -\n      5 /f5\n      8 total\n');
  });

  // ── -L longest line ─────────────────────────────────────────────────────────

  test('-L reports longest line display width', async () => {
    const h = makeIO({ args: ['wc', '-L'], stdinText: 'ab\nabcd\nx\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('4\n');
  });

  test('-L expands tab to next multiple of 8', async () => {
    const h = makeIO({ args: ['wc', '-L'], stdinText: 'a\tb\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('9\n');
  });

  test('-L counts multibyte by display width', async () => {
    const h = makeIO({ args: ['wc', '-L'], stdinText: 'café\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('4\n');
  });

  test('-L counts wide CJK as width 2', async () => {
    const h = makeIO({ args: ['wc', '-L'], stdinText: '你\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n');
  });

  test('-L total is the max longest line across files', async () => {
    const h = makeIO({ args: ['wc', '-L', '/la', '/lb'], files: { '/la': 'abc\n', '/lb': 'abcdef\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    // total bytes 4+7=11 → width 2; -L total = max(3,6) = 6
    expect(h.out()).toBe(' 3 /la\n 6 /lb\n 6 total\n');
  });

  test('-lL combined participates in width', async () => {
    const h = makeIO({ args: ['wc', '-lL'], stdinText: 'ab\nabcde\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2       5\n');
  });

  // ── unknown-flag reject + total on failed open ──────────────────────────────

  test('unknown short flag → invalid option, exit 1', async () => {
    const h = makeIO({ args: ['wc', '-Z'], stdinText: 'x' });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.err()).toBe('wc: invalid option -- \'Z\'\nTry \'wc --help\' for more information.\n');
    expect(h.out()).toBe('');
  });

  test('unknown long flag → unrecognized option, exit 1', async () => {
    const h = makeIO({ args: ['wc', '--bad'], stdinText: 'x' });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.err()).toBe('wc: unrecognized option \'--bad\'\nTry \'wc --help\' for more information.\n');
  });

  test('total line still printed when one file fails to open', async () => {
    const h = makeIO({ args: ['wc', '-l', '/ok', '/nope'], files: { '/ok': 'a\n' } });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.out()).toBe('1 /ok\n1 total\n');
    expect(h.err()).toContain('wc: /nope: No such file or directory');
  });

  test('total line printed as 0 when all files fail', async () => {
    const h = makeIO({ args: ['wc', '-l', '/n1', '/n2'] });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0 total\n');
  });

  test('single missing file → no total line', async () => {
    const h = makeIO({ args: ['wc', '-l', '/nope'] });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('-L: a carriage return resets the column (GNU display-width)', async () => {
    // `abc\r` → after CR the column is 0, so the longest line is 3 (abc), not 4.
    const h1 = makeIO({ args: ['wc', '-L'], stdinText: 'abc\r\n' });
    expect(await wcCommand(h1.io)).toBe(0);
    expect(h1.out()).toBe('3\n');
    // `abc\rXY` → abc reached 3, CR resets, XY reaches 2 → longest 3.
    const h2 = makeIO({ args: ['wc', '-L'], stdinText: 'abc\rXY\n' });
    expect(await wcCommand(h2.io)).toBe(0);
    expect(h2.out()).toBe('3\n');
  });
});
