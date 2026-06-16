import { expect, test, describe } from 'vitest';
import { foldCommand, foldLine } from './fold.ts';
import { makeIO } from './_test-io.ts';

describe('fold', () => {
  test('-w wraps at width', async () => {
    const h = makeIO({ args: ['fold', '-w', '3'], stdinText: 'abcdefg\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\ndef\ng\n');
  });

  test('lines shorter than width are unchanged', async () => {
    const h = makeIO({ args: ['fold', '-w', '10'], stdinText: 'short\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('short\n');
  });

  test('-s breaks at spaces', async () => {
    const h = makeIO({ args: ['fold', '-w', '10', '-s'], stdinText: 'hello world foo\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello \nworld foo\n');
  });

  test('default width 80', async () => {
    const long = 'x'.repeat(85);
    const h = makeIO({ args: ['fold'], stdinText: long + '\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x'.repeat(80) + '\n' + 'x'.repeat(5) + '\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['fold', '-w', '2', '/a'], files: { '/a': 'abcd\n' } });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab\ncd\n');
  });

  test('invalid width errors', async () => {
    const h = makeIO({ args: ['fold', '-w', '0'], stdinText: 'x\n' });
    expect(await foldCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['fold', '/missing'] });
    expect(await foldCommand(h.io)).toBe(1);
    expect(h.err()).toContain('fold: /missing:');
  });

  describe('foldLine', () => {
    test('hard wrap', () => { expect(foldLine('abcdef', 2, false)).toEqual(['ab', 'cd', 'ef']); });
    test('space wrap', () => { expect(foldLine('ab cd ef', 4, true)).toEqual(['ab ', 'cd ', 'ef']); });
  });
});
