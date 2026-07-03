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

  describe('circular stdin (`- -`)', () => {
    test('pairs adjacent lines round-robin', async () => {
      const h = makeIO({ args: ['paste', '-', '-'], stdinText: '1\n2\n3\n4\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1\t2\n3\t4\n');
    });
    test('odd line count pads the last row', async () => {
      const h = makeIO({ args: ['paste', '-', '-'], stdinText: '1\n2\n3\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1\t2\n3\t\n');
    });
    test('three dashes group into threes', async () => {
      const h = makeIO({ args: ['paste', '-', '-', '-'], stdinText: '1\n2\n3\n4\n5\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1\t2\t3\n4\t5\t\n');
    });
    test('serial `- -`: first dash drains stdin, second is empty', async () => {
      const h = makeIO({ args: ['paste', '-s', '-', '-'], stdinText: '1\n2\n3\n4\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1\t2\t3\t4\n\n');
    });
    test('mixed file + dashes', async () => {
      const h = makeIO({ args: ['paste', '-', '-', '/fm'], files: { '/fm': 'x\ny\nz\n' }, stdinText: '1\n2\n3\n4\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1\t2\tx\n3\t4\ty\n\t\tz\n');
    });
  });

  describe('-z (NUL line separator)', () => {
    test('output terminated by NUL', async () => {
      const h = makeIO({ args: ['paste', '-z', '-'], stdinText: 'a\nb\n' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a\nb\n\0');
    });
    test('input split on NUL, merged with -d', async () => {
      const h = makeIO({ args: ['paste', '-z', '-d', ',', '-', '-'], stdinText: 'a\0b\0' });
      expect(await pasteCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a,b\0');
    });
  });

  test('missing file aborts with NO partial output (exit 1)', async () => {
    const h = makeIO({ args: ['paste', '/pok', '/nope'], files: { '/pok': 'a\nb\n' } });
    expect(await pasteCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('paste: /nope:');
  });

  test('unknown flag exits 1', async () => {
    const h = makeIO({ args: ['paste', '-Z'], stdinText: 'a\n' });
    expect(await pasteCommand(h.io)).toBe(1);
    expect(h.err()).toContain('paste: invalid option -- \'Z\'');
  });

  describe('parseDelims', () => {
    test('escapes', () => { expect(parseDelims('\\t\\n')).toEqual(['\t', '\n']); });
    test('plain list', () => { expect(parseDelims(',;')).toEqual([',', ';']); });
  });
});
