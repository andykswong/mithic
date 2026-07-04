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

  // ── L4: GNU cut ALWAYS terminates each emitted line with LF ────────────────
  describe('unterminated input still gets a trailing LF', () => {
    test('-c on stdin with no final newline', async () => {
      const h = makeIO({ args: ['cut', '-c', '1'], stdinText: 'nonl' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('n\n');
    });
    test('-f on stdin with no final newline', async () => {
      const h = makeIO({ args: ['cut', '-d', ',', '-f', '1'], stdinText: 'a,b,c' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\n');
    });
    test('-c on a file with a mid-stream unterminated last line', async () => {
      const h = makeIO({ args: ['cut', '-c', '1', '/in'], files: { '/in': 'ab\ncd' } });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\nc\n');
    });
    test('empty stdin produces no output (no spurious LF)', async () => {
      const h = makeIO({ args: ['cut', '-c', '1'], stdinText: '' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('');
    });
    test('fully -s-suppressed unterminated input produces no output', async () => {
      const h = makeIO({ args: ['cut', '-d', ',', '-f', '1', '-s'], stdinText: 'nodelim' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('');
    });
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

  // ── empty -d / --output-delimiter map to NUL (GNU parity) ─────────────────
  describe('empty delimiters = NUL', () => {
    test('-d \'\' selects the whole line as field 1 (no NUL present)', async () => {
      const h = makeIO({ args: ['cut', '-d', '', '-f', '1'], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\tb\n');
    });
    test('-d \'\' splits on NUL', async () => {
      const h = makeIO({ args: ['cut', '-d', '', '-f', '2'], stdinText: 'a\0b\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('b\n');
    });
    test('--output-delimiter= joins fields with NUL', async () => {
      const h = makeIO({ args: ['cut', '-d', ':', '--output-delimiter=', '-f', '1,2'], stdinText: 'a:b:c\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\0b\n');
    });
    test('--output-delimiter= inserts NUL between merged char runs', async () => {
      const h = makeIO({ args: ['cut', '-c', '1,3', '--output-delimiter='], stdinText: 'abcde\n' });
      expect(await cutCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\0c\n');
    });
  });

  // ── argument/validation diagnostics (GNU parity) ──────────────────────────
  describe('argument diagnostics', () => {
    test('no list → both diagnostic lines incl. the Try line', async () => {
      const h = makeIO({ args: ['cut'], stdinText: '' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cut: you must specify a list of bytes, characters, or fields\nTry \'cut --help\' for more information.\n');
    });
    test('-f with no argument → option requires an argument', async () => {
      const h = makeIO({ args: ['cut', '-f'], stdinText: '' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cut: option requires an argument -- \'f\'\nTry \'cut --help\' for more information.\n');
    });
    test('-c with no argument → option requires an argument', async () => {
      const h = makeIO({ args: ['cut', '-c'], stdinText: '' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cut: option requires an argument -- \'c\'\nTry \'cut --help\' for more information.\n');
    });
    test('-f \'\' (explicit empty) is a LIST error, not a missing-arg error', async () => {
      const h = makeIO({ args: ['cut', '-f', ''], stdinText: 'a\tb\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: fields are numbered from 1');
    });
    test('-c 1-0 → invalid decreasing range (upper bound 0)', async () => {
      const h = makeIO({ args: ['cut', '-c', '1-0'], stdinText: 'abc\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid decreasing range');
    });
    test('-c 2-0 → invalid decreasing range', async () => {
      const h = makeIO({ args: ['cut', '-c', '2-0'], stdinText: 'abc\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: invalid decreasing range');
    });
    test('-c 0-2 → numbered from 1 (lower bound 0)', async () => {
      const h = makeIO({ args: ['cut', '-c', '0-2'], stdinText: 'abc\n' });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toContain('cut: byte/character positions are numbered from 1');
    });
    test('missing file uses canonical errno text', async () => {
      const h = makeIO({ args: ['cut', '-c', '1', '/noexist'] });
      expect(await cutCommand(h.io)).toBe(1);
      expect(h.err()).toBe('cut: /noexist: No such file or directory\n');
    });
  });
});
