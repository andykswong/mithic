import { expect, test, describe } from 'vitest';
import { tailCommand } from './tail.ts';
import { makeIO } from './_test-io.ts';

describe('tail', () => {
  test('default prints last 10 lines', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const h = makeIO({ args: ['tail'], stdinText: lines });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe(Array.from({ length: 10 }, (_, i) => `L${i + 11}`).join('\n') + '\n');
  });

  test('-n N limits lines', async () => {
    const h = makeIO({ args: ['tail', '-n', '2'], stdinText: 'a\nb\nc\nd\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nd\n');
  });

  test('-n +N starts at line N', async () => {
    const h = makeIO({ args: ['tail', '-n', '+2'], stdinText: 'a\nb\nc\nd\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nc\nd\n');
  });

  test('-c N limits bytes', async () => {
    const h = makeIO({ args: ['tail', '-c', '3'], stdinText: 'abcdef' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('def');
  });

  test('-c +N starts at byte N', async () => {
    const h = makeIO({ args: ['tail', '-c', '+3'], stdinText: 'abcdef' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cdef');
  });

  test('fewer lines than N prints all', async () => {
    const h = makeIO({ args: ['tail', '-n', '10'], stdinText: 'one\ntwo\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('one\ntwo\n');
  });

  test('multiple files print headers', async () => {
    const h = makeIO({ args: ['tail', '-n', '1', '/a', '/b'], files: { '/a': 'A1\nA2\n', '/b': 'B1\nB2\n' } });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('==> /a <==\nA2\n\n==> /b <==\nB2\n');
  });

  test('-q suppresses headers', async () => {
    const h = makeIO({ args: ['tail', '-q', '-n', '1', '/a', '/b'], files: { '/a': 'A1\nA2\n', '/b': 'B1\nB2\n' } });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('A2\nB2\n');
  });

  test('-f noted as unsupported on stderr but still runs', async () => {
    const h = makeIO({ args: ['tail', '-f', '-n', '1'], stdinText: 'a\nb\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
    expect(h.err()).toContain('not supported');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['tail', '/missing'] });
    expect(await tailCommand(h.io)).toBe(1);
    expect(h.err()).toContain('tail:');
  });
});
