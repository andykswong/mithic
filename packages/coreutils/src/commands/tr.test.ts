import { expect, test, describe } from 'vitest';
import { trCommand, expandSet } from './tr.ts';
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
});
