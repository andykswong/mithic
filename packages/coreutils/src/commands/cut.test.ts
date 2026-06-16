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
      const r = parseList('1,4-6,9-');
      expect(r).toEqual([{ from: 1, to: 1 }, { from: 4, to: 6 }, { from: 9, to: Infinity }]);
    });
  });
});
