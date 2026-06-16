import { expect, test, describe } from 'vitest';
import { pasteCommand, parseDelims } from './paste.ts';
import { makeIO } from './_test-io.ts';

describe('paste', () => {
  test('merges two files tab-separated', async () => {
    const h = makeIO({ args: ['paste', '/a', '/b'], files: { '/a': '1\n2\n', '/b': 'x\ny\n' } });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\tx\n2\ty\n');
  });

  test('-d sets delimiter', async () => {
    const h = makeIO({ args: ['paste', '-d', ',', '/a', '/b'], files: { '/a': '1\n2\n', '/b': 'x\ny\n' } });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1,x\n2,y\n');
  });

  test('-d cycles through multiple delimiters', async () => {
    const h = makeIO({
      args: ['paste', '-d', ',;', '/a', '/b', '/c'],
      files: { '/a': '1\n', '/b': '2\n', '/c': '3\n' },
    });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1,2;3\n');
  });

  test('-s serial joins each file onto one line', async () => {
    const h = makeIO({ args: ['paste', '-s', '/a'], files: { '/a': 'a\nb\nc\n' } });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\tb\tc\n');
  });

  test('-s with -d delim', async () => {
    const h = makeIO({ args: ['paste', '-s', '-d', ',', '/a'], files: { '/a': 'a\nb\nc\n' } });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,b,c\n');
  });

  test('uneven line counts pad with empty', async () => {
    const h = makeIO({ args: ['paste', '/a', '/b'], files: { '/a': '1\n2\n3\n', '/b': 'x\n' } });
    expect(await pasteCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\tx\n2\t\n3\t\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['paste', '/missing'] });
    expect(await pasteCommand(h.io)).toBe(1);
    expect(h.err()).toContain('paste: /missing:');
  });

  describe('parseDelims', () => {
    test('escapes', () => { expect(parseDelims('\\t\\n')).toEqual(['\t', '\n']); });
    test('plain list', () => { expect(parseDelims(',;')).toEqual([',', ';']); });
  });
});
