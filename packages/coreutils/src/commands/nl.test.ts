import { expect, test, describe } from 'vitest';
import { nlCommand } from './nl.ts';
import { makeIO } from './_test-io.ts';

describe('nl', () => {
  test('numbers non-empty lines by default (-b t)', async () => {
    const h = makeIO({ args: ['nl'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n      \n     2\tb\n');
  });

  test('-b a numbers all lines', async () => {
    const h = makeIO({ args: ['nl', '-b', 'a'], stdinText: 'a\n\nb\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     2\t\n     3\tb\n');
  });

  test('-w sets width', async () => {
    const h = makeIO({ args: ['nl', '-w', '3'], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('  1\tx\n');
  });

  test('-s sets separator', async () => {
    const h = makeIO({ args: ['nl', '-s', ': '], stdinText: 'x\n' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1: x\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['nl', '/a'], files: { '/a': 'one\ntwo\n' } });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tone\n     2\ttwo\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['nl'], stdinText: '' });
    expect(await nlCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['nl', '/missing'] });
    expect(await nlCommand(h.io)).toBe(1);
    expect(h.err()).toContain('nl: /missing:');
  });
});
