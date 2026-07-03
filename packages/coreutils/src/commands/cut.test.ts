import { expect, test, describe } from 'vitest';
import { cutCommand, parseList } from './cut.ts';
import { makeIO } from './_test-io.ts';

describe('cut', () => {
  test('-f with default tab delim', async () => {
    const h = makeIO({ args: ['cut', '-f', '2'], stdinText: 'a\tb\tc\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('-f with -d delim', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '1,3'], stdinText: 'a,b,c\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,c\n');
  });

  test('-f range 2-', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '2-'], stdinText: 'a,b,c,d\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b,c,d\n');
  });

  test('-f range -2', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '-2'], stdinText: 'a,b,c\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,b\n');
  });

  test('-c selects chars', async () => {
    const h = makeIO({ args: ['cut', '-c', '1-3'], stdinText: 'abcdef\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\n');
  });

  test('-c discrete positions', async () => {
    const h = makeIO({ args: ['cut', '-c', '1,3,5'], stdinText: 'abcdef\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ace\n');
  });

  test('-b selects bytes', async () => {
    const h = makeIO({ args: ['cut', '-b', '1-2'], stdinText: 'abcd\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab\n');
  });

  test('-s suppresses lines without delim', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '1', '-s'], stdinText: 'a,b\nnodelim\nc,d\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\n');
  });

  test('line without delim printed whole without -s', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '1'], stdinText: 'nodelim\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('nodelim\n');
  });

  test('--output-delimiter changes join', async () => {
    const h = makeIO({ args: ['cut', '-d', ',', '-f', '1,2', '--output-delimiter=:'], stdinText: 'a,b,c\n' });
    expect(await cutCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a:b\n');
  });

  test('no list specified errors', async () => {
    const h = makeIO({ args: ['cut'], stdinText: 'x\n' });
    expect(await cutCommand(h.io)).toBe(1);
    expect(h.err()).toContain('you must specify');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['cut', '-f', '1', '/missing'] });
    expect(await cutCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cut: /missing:');
  });

  describe('parseList', () => {
    test('mixed', () => {
      const r = parseList('1,4-6,9-', true);
      expect(r).toEqual([{ from: 1, to: 1 }, { from: 4, to: 6 }, { from: 9, to: Infinity }]);
    });
    test('decreasing range throws', () => {
      expect(() => parseList('3-1', true)).toThrow('invalid decreasing range');
    });
    test('zero position throws', () => {
      expect(() => parseList('0', true)).toThrow('fields are numbered from 1');
      expect(() => parseList('0', false)).toThrow('byte/character positions are numbered from 1');
    });
    test('non-numeric throws with quoted token', () => {
      expect(() => parseList('x', true)).toThrow('invalid field value ‘x’');
      expect(() => parseList('x', false)).toThrow('invalid byte/character position ‘x’');
    });
    test('bare dash throws', () => {
      expect(() => parseList('-', true)).toThrow('invalid range with no endpoint: -');
    });
    test('double-dash range throws', () => {
      expect(() => parseList('1--2', true)).toThrow('invalid field range');
      expect(() => parseList('1-2-', false)).toThrow('invalid byte or character range');
    });
    test('trailing comma → empty item throws', () => {
      expect(() => parseList('1,', true)).toThrow('fields are numbered from 1');
    });
  });

  describe('--complement', () => {
    test('inverts field selection', async () => {
      const h = makeIO({ args: ['cut', '--complement', '-f', '2'], stdinText: 'a\tb\tc\td\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\tc\td\n');
    });
    test('inverts char selection', async () => {
      const h = makeIO({ args: ['cut', '--complement', '-c', '2-3'], stdinText: 'abcdef\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('adef\n');
    });
    test('complement of all fields yields empty', async () => {
      const h = makeIO({ args: ['cut', '--complement', '-f', '1-2'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('\n');
    });
  });

  describe('malformed LIST → exit 1', () => {
    test('0-3', async () => {
      const h = makeIO({ args: ['cut', '-f', '0-3'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cut: fields are numbered from 1\nTry \'cut --help\' for more information.\n');
    });
    test('x (non-numeric)', async () => {
      const h = makeIO({ args: ['cut', '-f', 'x'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid field value ‘x’');
    });
    test('3-1 decreasing', async () => {
      const h = makeIO({ args: ['cut', '-f', '3-1'], stdinText: 'a\tb\tc\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid decreasing range');
    });
    test('bare dash', async () => {
      const h = makeIO({ args: ['cut', '-f', '-'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid range with no endpoint: -');
    });
  });

  describe('flag-combo validation', () => {
    test('two lists → only one may be specified', async () => {
      const h = makeIO({ args: ['cut', '-f', '1', '-c', '1'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: only one list may be specified');
    });
    test('-d with -c → input delimiter makes sense only with fields', async () => {
      const h = makeIO({ args: ['cut', '-c', '1', '-d', ','], stdinText: 'ab\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('an input delimiter makes sense');
    });
    test('-s with -c → suppressing non-delimited only with fields', async () => {
      const h = makeIO({ args: ['cut', '-c', '1', '-s'], stdinText: 'ab\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('suppressing non-delimited lines makes sense');
    });
    test('multichar delimiter rejected', async () => {
      const h = makeIO({ args: ['cut', '-d', '::', '-f', '1'], stdinText: 'a::b\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('the delimiter must be a single character');
    });
    test('unknown flag → exit 1', async () => {
      const h = makeIO({ args: ['cut', '-Z'], stdinText: 'a\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid option -- \'Z\'');
    });
  });

  describe('--output-delimiter in char/byte mode', () => {
    test('inserts between merged runs (single positions stay separate)', async () => {
      const h = makeIO({ args: ['cut', '-c', '1,2,4', '--output-delimiter=:'], stdinText: 'abcdef\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a:b:d\n');
    });
    test('overlapping ranges merge into one run', async () => {
      const h = makeIO({ args: ['cut', '-c', '1-2,2-3', '--output-delimiter=:'], stdinText: 'abcdef\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('abc\n');
    });
    test('adjacent (non-overlapping) ranges stay separate', async () => {
      const h = makeIO({ args: ['cut', '-c', '1-2,3-4', '--output-delimiter=:'], stdinText: 'abcdef\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('ab:cd\n');
    });
    test('byte mode', async () => {
      const h = makeIO({ args: ['cut', '-b', '1-2,4-5', '--output-delimiter=:'], stdinText: 'abcdef\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('ab:de\n');
    });
  });
});
