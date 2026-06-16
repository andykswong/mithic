import { expect, test, describe } from 'vitest';
import { headCommand } from './head.ts';
import { makeIO } from './_test-io.ts';

describe('head', () => {
  test('default prints first 10 lines', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const h = makeIO({ args: ['head'], stdinText: lines });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe(Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
  });

  test('-n N limits lines', async () => {
    const h = makeIO({ args: ['head', '-n', '2'], stdinText: 'a\nb\nc\nd\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('legacy -N form', async () => {
    const h = makeIO({ args: ['head', '-3'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  test('-c N limits bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '4'], stdinText: 'abcdef' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcd');
  });

  test('fewer lines than N prints all', async () => {
    const h = makeIO({ args: ['head', '-n', '10'], stdinText: 'one\ntwo\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('one\ntwo\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['head', '-n', '1', '/a'], files: { '/a': 'x\ny\n' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });

  test('multiple files print headers', async () => {
    const h = makeIO({ args: ['head', '-n', '1', '/a', '/b'], files: { '/a': 'A\n', '/b': 'B\n' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('==> /a <==\nA\n\n==> /b <==\nB\n');
  });

  test('-q suppresses headers', async () => {
    const h = makeIO({ args: ['head', '-q', '-n', '1', '/a', '/b'], files: { '/a': 'A\n', '/b': 'B\n' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('A\nB\n');
  });

  test('-v forces header for single file', async () => {
    const h = makeIO({ args: ['head', '-v', '-n', '1', '/a'], files: { '/a': 'A\n' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('==> /a <==\nA\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['head'], stdinText: '' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['head', '/missing'] });
    expect(await headCommand(h.io)).toBe(1);
    expect(h.err()).toContain('head:');
  });
});
