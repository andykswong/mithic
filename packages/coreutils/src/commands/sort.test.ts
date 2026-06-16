import { expect, test, describe } from 'vitest';
import { sortCommand, parseKey } from './sort.ts';
import { makeIO } from './_test-io.ts';

describe('sort', () => {
  test('lexicographic sort', async () => {
    const h = makeIO({ args: ['sort'], stdinText: 'banana\napple\ncherry\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('apple\nbanana\ncherry\n');
  });

  test('-n numeric sort', async () => {
    const h = makeIO({ args: ['sort', '-n'], stdinText: '10\n2\n1\n20\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n10\n20\n');
  });

  test('-r reverse', async () => {
    const h = makeIO({ args: ['sort', '-r'], stdinText: 'a\nb\nc\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nb\na\n');
  });

  test('-u unique', async () => {
    const h = makeIO({ args: ['sort', '-u'], stdinText: 'b\na\nb\na\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('-f fold case', async () => {
    const h = makeIO({ args: ['sort', '-f'], stdinText: 'Banana\napple\nCherry\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('apple\nBanana\nCherry\n');
  });

  test('-k key with -t separator', async () => {
    const h = makeIO({ args: ['sort', '-t', ':', '-k', '2', '-n'], stdinText: 'a:3\nb:1\nc:2\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b:1\nc:2\na:3\n');
  });

  test('-k2,2n per-key numeric', async () => {
    const h = makeIO({ args: ['sort', '-t', ',', '-k2,2n'], stdinText: 'x,10\ny,2\nz,1\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('z,1\ny,2\nx,10\n');
  });

  test('-b ignores leading blanks', async () => {
    const h = makeIO({ args: ['sort', '-b'], stdinText: '   b\n a\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe(' a\n   b\n');
  });

  test('stable for equal keys', async () => {
    const h = makeIO({ args: ['sort', '-k', '1,1'], stdinText: 'a first\na second\na third\n' });
    expect(await sortCommand(h.io)).toBe(0);
    // GNU last-resort compares whole lines, so this orders them; verify deterministic
    expect(h.out()).toBe('a first\na second\na third\n');
  });

  test('multiple files concatenated and sorted', async () => {
    const h = makeIO({ args: ['sort', '/a', '/b'], files: { '/a': 'c\na\n', '/b': 'b\n' } });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['sort'], stdinText: '' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['sort', '/missing'] });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toContain('sort:');
  });

  describe('parseKey', () => {
    test('field only', () => { expect(parseKey('2')).toMatchObject({ startField: 2, startChar: 1 }); });
    test('field.char with end+numeric', () => {
      expect(parseKey('2.3,4n')).toMatchObject({ startField: 2, startChar: 3, endField: 4, numeric: true });
    });
  });
});
