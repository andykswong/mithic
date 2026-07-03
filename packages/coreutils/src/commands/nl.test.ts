import { expect, test, describe } from 'vitest';
import { nlCommand, breToRegExp } from './nl.ts';
import { makeIO } from './_test-io.ts';

describe('nl', () => {
  test('numbers non-empty lines by default (-b t)', async () => {
    const h = makeIO({ args: ['nl'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    // blank column = width 6 + separator (tab) 1 = 7 spaces
    expect(h.out()).toBe('     1\ta\n       \n     2\tb\n');
  });

  test('-b a numbers all lines', async () => {
    const h = makeIO({ args: ['nl', '-b', 'a'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     2\t\n     3\tb\n');
  });

  test('-w sets width', async () => {
    const h = makeIO({ args: ['nl', '-w', '3'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('  1\tx\n');
  });

  test('-s sets separator', async () => {
    const h = makeIO({ args: ['nl', '-s', ': '], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1: x\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['nl', '/a'], files: { '/a': 'one\ntwo\n' } });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tone\n     2\ttwo\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['nl'], stdinText: '' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['nl', '/missing'] });
    expect(await nlCommand(h.io)).toBe(1);
    expect(h.err()).toContain('nl: /missing:');
  });

  // ── -v / -i (GNU parity) ────────────────────────────────────────────────────

  test('-v sets the starting number', async () => {
    const h = makeIO({ args: ['nl', '-v', '5'], stdinText: 'a\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     5\ta\n     6\tb\n');
  });

  test('-i sets the increment', async () => {
    const h = makeIO({ args: ['nl', '-i', '3'], stdinText: 'a\nb\nc\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     4\tb\n     7\tc\n');
  });

  test('-v and -i combine', async () => {
    const h = makeIO({ args: ['nl', '-v', '10', '-i', '5'], stdinText: 'a\nb\nc\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('    10\ta\n    15\tb\n    20\tc\n');
  });

  test('-v accepts a negative start', async () => {
    const h = makeIO({ args: ['nl', '-v', '-3'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('    -3\tx\n');
  });

  // ── -n formats ──────────────────────────────────────────────────────────────

  test('-n ln left-justifies the number', async () => {
    const h = makeIO({ args: ['nl', '-n', 'ln'], stdinText: 'a\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1     \ta\n');
  });

  test('-n rn right-justifies (default)', async () => {
    const h = makeIO({ args: ['nl', '-n', 'rn'], stdinText: 'a\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n');
  });

  test('-n rz right-justifies zero-padded', async () => {
    const h = makeIO({ args: ['nl', '-n', 'rz'], stdinText: 'a\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000001\ta\n');
  });

  test('-n rz honors -w width', async () => {
    const h = makeIO({ args: ['nl', '-n', 'rz', '-w', '3'], stdinText: 'a\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('001\ta\n');
  });

  test('invalid -n format errors and exits 1', async () => {
    const h = makeIO({ args: ['nl', '-n', 'bad'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid line numbering format');
  });

  // ── -b p<BRE> ─────────────────────────────────────────────────────────────

  test('-b p<BRE> numbers only matching lines', async () => {
    const h = makeIO({ args: ['nl', '-b', 'pfoo'], stdinText: 'foo\nbar\nfoobar\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tfoo\n       bar\n     2\tfoobar\n');
  });

  test('-b p^anchored BRE', async () => {
    const h = makeIO({ args: ['nl', '-b', 'p^foo'], stdinText: 'foo\nafoo\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tfoo\n       afoo\n');
  });

  test('invalid -b style errors and exits 1', async () => {
    const h = makeIO({ args: ['nl', '-b', 'z'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid body numbering style');
  });

  // ── -l join blank lines ─────────────────────────────────────────────────────

  test('-l groups N consecutive blank lines as one', async () => {
    const h = makeIO({ args: ['nl', '-b', 'a', '-l', '2'], stdinText: '\n\n\n\na\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('       \n     1\t\n       \n     2\t\n     3\ta\n');
  });

  // ── no-trailing-newline: nl always adds one ─────────────────────────────────

  test('nl terminates an unterminated final line', async () => {
    const h = makeIO({ args: ['nl'], stdinText: 'a\nb' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     2\tb\n');
  });

  test('nl terminates an unterminated final line from a file', async () => {
    const h = makeIO({ args: ['nl', '/f'], files: { '/f': 'a\nb' } });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     2\tb\n');
  });

  // ── blank-line pad width = width + separator ────────────────────────────────

  test('blank line pads to width + separator width', async () => {
    const h = makeIO({ args: ['nl'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    // blank column = 6 (width) + 1 (tab) = 7 spaces
    expect(h.out()).toBe('     1\ta\n       \n     2\tb\n');
  });

  test('blank line pad tracks a multi-char separator', async () => {
    const h = makeIO({ args: ['nl', '-s', '>>'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    // blank column = 6 + 2 = 8 spaces
    expect(h.out()).toBe('     1>>a\n        \n     2>>b\n');
  });

  test('-b n numbers no lines but still pads', async () => {
    const h = makeIO({ args: ['nl', '-b', 'n'], stdinText: 'a\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('       a\n       b\n');
  });

  // ── unknown-flag reject ──────────────────────────────────────────────────────

  test('unknown flag → invalid option, exit 1', async () => {
    const h = makeIO({ args: ['nl', '-Z'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(1);
    expect(h.err()).toBe('nl: invalid option -- \'Z\'\nTry \'nl --help\' for more information.\n');
  });

  describe('breToRegExp', () => {
    test('literal metachars', () => {
      expect(breToRegExp('a+b').test('a+b')).toBe(true);
      expect(breToRegExp('a+b').test('aab')).toBe(false);
    });
    test('escaped operators', () => {
      expect(breToRegExp('a\\{2\\}').test('aa')).toBe(true);
      expect(breToRegExp('a\\{2\\}').test('a')).toBe(false);
    });
  });
});
