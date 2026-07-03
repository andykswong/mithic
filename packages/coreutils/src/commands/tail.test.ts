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

  test('missing file uses canonical errno text', async () => {
    const h = makeIO({ args: ['tail', '/missing'] });
    expect(await tailCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tail: cannot open \'/missing\' for reading: No such file or directory\n');
  });

  // ── legacy -N ─────────────────────────────────────────────────────────────
  test('legacy -N form (last N lines)', async () => {
    const h = makeIO({ args: ['tail', '-3'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nd\ne\n');
  });

  // ── negative -c/-n mean "last N" ──────────────────────────────────────────
  test('-c -3 = last 3 bytes', async () => {
    const h = makeIO({ args: ['tail', '-c', '-3'], stdinText: 'abcdef' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('def');
  });

  test('-n -3 = last 3 lines', async () => {
    const h = makeIO({ args: ['tail', '-n', '-3'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nd\ne\n');
  });

  test('-c -3 on a file', async () => {
    const h = makeIO({ args: ['tail', '-c', '-3', '/a'], files: { '/a': 'abcdef' } });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('def');
  });

  // ── size suffixes ─────────────────────────────────────────────────────────
  test('-c 1k = last 1024 bytes', async () => {
    const h = makeIO({ args: ['tail', '-c', '1k'], stdinText: 'x'.repeat(2000) });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1024);
  });

  test('-c 2b = last 1024 bytes', async () => {
    const h = makeIO({ args: ['tail', '-c', '2b'], stdinText: 'x'.repeat(2000) });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1024);
  });

  test('-c +1k starts at byte 1024', async () => {
    const h = makeIO({ args: ['tail', '-c', '+1k'], stdinText: 'x'.repeat(2000) });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(2000 - 1024 + 1); // 977
  });

  // ── invalid counts ────────────────────────────────────────────────────────
  test('non-numeric -n exits 1 with GNU message', async () => {
    const h = makeIO({ args: ['tail', '-n', 'abc'], stdinText: 'a\n' });
    expect(await tailCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tail: invalid number of lines: ‘abc’\n');
  });

  test('non-numeric -c exits 1 with GNU message', async () => {
    const h = makeIO({ args: ['tail', '-c', 'xyz'], stdinText: 'a\n' });
    expect(await tailCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tail: invalid number of bytes: ‘xyz’\n');
  });

  test('lowercase g suffix is invalid', async () => {
    const h = makeIO({ args: ['tail', '-c', '1g'], stdinText: 'a\n' });
    expect(await tailCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tail: invalid number of bytes: ‘1g’\n');
  });

  test('-n +0 = whole file (same as +1)', async () => {
    const h = makeIO({ args: ['tail', '-n', '+0'], stdinText: 'a\nb\nc\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  // ── -c / -n last-wins ordering (GNU parity) ───────────────────────────────
  test('-c5 -n2: -n wins (last), prints last 2 lines', async () => {
    const h = makeIO({ args: ['tail', '-c5', '-n2'], stdinText: 'l1\nl2\nl3\nl4\nl5\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('l4\nl5\n');
  });

  test('-n2 -c5: -c wins (last), prints last 5 bytes', async () => {
    const h = makeIO({ args: ['tail', '-n2', '-c5'], stdinText: 'l1\nl2\nl3\nl4\nl5\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('4\nl5\n');
  });

  test('-c3 -n2: line mode wins, prints last 2 lines', async () => {
    const h = makeIO({ args: ['tail', '-c3', '-n2'], stdinText: 'a\nbb\nccc\n' });
    expect(await tailCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bb\nccc\n');
  });
});
