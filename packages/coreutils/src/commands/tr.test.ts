import { expect, test, describe } from 'vitest';
import { trCommand, expandSet, parseSet } from './tr.ts';
import { makeIO } from './_test-io.ts';

describe('tr', () => {
  test('translate set1 to set2', async () => {
    const h = makeIO({ args: ['tr', 'abc', 'xyz'], stdinText: 'aabbcc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xxyyzz\n');
  });

  test('range a-z to A-Z (uppercase)', async () => {
    const h = makeIO({ args: ['tr', 'a-z', 'A-Z'], stdinText: 'hello\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('HELLO\n');
  });

  test('character class [:lower:] to [:upper:]', async () => {
    const h = makeIO({ args: ['tr', '[:lower:]', '[:upper:]'], stdinText: 'Mixed Case\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('MIXED CASE\n');
  });

  test('-d deletes chars in set1', async () => {
    const h = makeIO({ args: ['tr', '-d', 'aeiou'], stdinText: 'hello world\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hll wrld\n');
  });

  test('-d with [:digit:] removes digits', async () => {
    const h = makeIO({ args: ['tr', '-d', '[:digit:]'], stdinText: 'a1b2c3\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\n');
  });

  test('-s squeezes repeats of set1', async () => {
    const h = makeIO({ args: ['tr', '-s', 'a'], stdinText: 'aaabbbaa\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abbba\n');
  });

  test('-s with translate squeezes set2', async () => {
    const h = makeIO({ args: ['tr', '-s', 'a-z', 'A-Z'], stdinText: 'aabb\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('AB\n');
  });

  test('-c complement: keep only digits when translating non-digits', async () => {
    const h = makeIO({ args: ['tr', '-cd', '[:digit:]'], stdinText: 'a1b2c3\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('123');
  });

  test('translate pads set2 with its last char', async () => {
    const h = makeIO({ args: ['tr', 'abc', 'x'], stdinText: 'abc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xxx\n');
  });

  test('-s squeeze spaces', async () => {
    const h = makeIO({ args: ['tr', '-s', ' '], stdinText: 'a    b   c\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a b c\n');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['tr'], stdinText: 'x' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing operand');
  });

  // ── [c*] repeat (GNU parity) ────────────────────────────────────────────────

  test('[x*] repeats to fill SET1 length', async () => {
    const h = makeIO({ args: ['tr', 'abc', '[x*]'], stdinText: 'abc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xxx\n');
  });

  test('[x*N] repeats exactly N times', async () => {
    const h = makeIO({ args: ['tr', 'abcde', 'y[x*3]'], stdinText: 'abcde\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('yxxxx\n');
  });

  test('[x*] interior repeat fills the gap', async () => {
    const h = makeIO({ args: ['tr', 'a-f', 'X[y*]Z'], stdinText: 'abcdef\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XyyyyZ\n');
  });

  test('[x*012] octal count', async () => {
    const h = makeIO({ args: ['tr', 'a-j', '[x*012]'], stdinText: 'abcdefghij\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xxxxxxxxxx\n'); // 012 octal = 10
  });

  // ── -t truncate ─────────────────────────────────────────────────────────────

  test('-t truncates SET1 to SET2 length (extra chars untranslated)', async () => {
    const h = makeIO({ args: ['tr', '-t', 'abc', 'xy'], stdinText: 'abc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xyc\n');
  });

  test('without -t, SET2 is padded with its last char', async () => {
    const h = makeIO({ args: ['tr', 'abc', 'xy'], stdinText: 'abc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xyy\n');
  });

  // ── [=c=] equivalence class ──────────────────────────────────────────────────

  test('[=c=] equivalence maps its character', async () => {
    const h = makeIO({ args: ['tr', '[=a=]', 'X'], stdinText: 'aAbc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XAbc\n');
  });

  // ── operand-count validation ─────────────────────────────────────────────────

  test('translate with an extra operand errors', async () => {
    const h = makeIO({ args: ['tr', 'a', 'b', 'c'], stdinText: 'x\n' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tr: extra operand ‘c’\nTry \'tr --help\' for more information.\n');
  });

  test('translate with only one operand errors', async () => {
    const h = makeIO({ args: ['tr', 'a'], stdinText: 'x\n' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tr: missing operand after ‘a’\nTwo strings must be given when translating.\nTry \'tr --help\' for more information.\n');
  });

  test('-d with two operands errors with the delete hint', async () => {
    const h = makeIO({ args: ['tr', '-d', 'a', 'b'], stdinText: 'x\n' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tr: extra operand ‘b’\nOnly one string may be given when deleting without squeezing repeats.\nTry \'tr --help\' for more information.\n');
  });

  test('-d with three operands errors without the hint', async () => {
    const h = makeIO({ args: ['tr', '-d', 'a', 'b', 'c'], stdinText: 'x\n' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tr: extra operand ‘b’\nTry \'tr --help\' for more information.\n');
  });

  test('-ds with one operand errors', async () => {
    const h = makeIO({ args: ['tr', '-ds', 'a'], stdinText: 'x\n' });
    expect(await trCommand(h.io)).toBe(1);
    expect(h.err()).toContain('Two strings must be given when both deleting and squeezing repeats.');
  });

  test('-ds with two operands is valid', async () => {
    const h = makeIO({ args: ['tr', '-ds', 'a', 'b'], stdinText: 'aabbcc\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bcc\n');
  });

  test('-s alone with one operand is valid', async () => {
    const h = makeIO({ args: ['tr', '-s', 'a'], stdinText: 'aabb\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abb\n');
  });

  test('octal escape maps a char', async () => {
    // \101 is octal for 'A' (65).
    const h = makeIO({ args: ['tr', '\\101', 'A'], stdinText: 'A\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('A\n');
  });

  test('octal escape in delete set', async () => {
    const h = makeIO({ args: ['tr', '-d', '\\101'], stdinText: 'ABA\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('B\n');
  });

  test('[:xdigit:] class translates', async () => {
    const h = makeIO({ args: ['tr', '-d', '[:xdigit:]'], stdinText: 'g1f2z\n' });
    expect(await trCommand(h.io)).toBe(0);
    expect(h.out()).toBe('gz\n');
  });

  describe('expandSet', () => {
    test('ranges', () => { expect(expandSet('a-e').join('')).toBe('abcde'); });
    test('classes', () => { expect(expandSet('[:digit:]').join('')).toBe('0123456789'); });
    test('escapes', () => { expect(expandSet('\\t\\n')).toEqual(['\t', '\n']); });
    test('octal escape \\101 → A', () => { expect(expandSet('\\101')).toEqual(['A']); });
    test('octal escape \\0 → NUL', () => { expect(expandSet('\\0')).toEqual(['\0']); });
    test('xdigit class', () => { expect(expandSet('[:xdigit:]').join('')).toBe('0123456789ABCDEFabcdef'); });
    test('cntrl includes NUL and DEL', () => {
      const c = expandSet('[:cntrl:]');
      expect(c).toContain('\x00');
      expect(c).toContain('\x7f');
    });
    test('print includes space, graph excludes it', () => {
      expect(expandSet('[:print:]')).toContain(' ');
      expect(expandSet('[:graph:]')).not.toContain(' ');
    });
  });

  describe('parseSet', () => {
    test('open repeat token', () => {
      expect(parseSet('[x*]')).toEqual([{ kind: 'repeat', char: 'x', count: null }]);
    });
    test('counted repeat token', () => {
      expect(parseSet('[x*3]')).toEqual([{ kind: 'repeat', char: 'x', count: 3 }]);
    });
    test('octal counted repeat', () => {
      expect(parseSet('[x*012]')).toEqual([{ kind: 'repeat', char: 'x', count: 10 }]);
    });
    test('mixed chars + repeat', () => {
      expect(parseSet('a[y*]')).toEqual([
        { kind: 'chars', chars: ['a'] },
        { kind: 'repeat', char: 'y', count: null },
      ]);
    });
  });
});
