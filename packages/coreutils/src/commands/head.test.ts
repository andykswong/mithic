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

  test('missing file uses canonical errno text', async () => {
    const h = makeIO({ args: ['head', '/missing'] });
    expect(await headCommand(h.io)).toBe(1);
    expect(h.err()).toBe('head: cannot open \'/missing\' for reading: No such file or directory\n');
  });

  // ── negative counts (all-but-last-N) ──────────────────────────────────────
  test('-c -3 prints all but last 3 bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '-3'], stdinText: 'abcdefgh' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcde');
  });

  test('-n -2 prints all but last 2 lines', async () => {
    const h = makeIO({ args: ['head', '-n', '-2'], stdinText: 'a\nb\nc\nd\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('-c -N larger than input yields empty', async () => {
    const h = makeIO({ args: ['head', '-c', '-5'], stdinText: 'abc' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-n -N larger than input yields empty', async () => {
    const h = makeIO({ args: ['head', '-n', '-5'], stdinText: 'a\nb\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-c -0 prints everything', async () => {
    const h = makeIO({ args: ['head', '-c', '-0'], stdinText: 'abc' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc');
  });

  test('-c -3 on a file', async () => {
    const h = makeIO({ args: ['head', '-c', '-3', '/a'], files: { '/a': 'abcdefgh' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcde');
  });

  test('-n -2 on a file', async () => {
    const h = makeIO({ args: ['head', '-n', '-2', '/a'], files: { '/a': 'a\nb\nc\nd\n' } });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  // ── size suffixes ─────────────────────────────────────────────────────────
  test('-c 1k = 1024 bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '1k'], stdinText: 'x'.repeat(2000) });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1024);
  });

  test('-c 1K = 1024 bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '1K'], stdinText: 'x'.repeat(2000) });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1024);
  });

  test('-c 1KB = 1000 bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '1KB'], stdinText: 'x'.repeat(2000) });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1000);
  });

  test('-c 2b = 1024 bytes', async () => {
    const h = makeIO({ args: ['head', '-c', '2b'], stdinText: 'x'.repeat(2000) });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out().length).toBe(1024);
  });

  test('-c 1M larger than input prints all', async () => {
    const h = makeIO({ args: ['head', '-c', '1M'], stdinText: 'abcde' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcde');
  });

  // ── invalid counts ────────────────────────────────────────────────────────
  test('non-numeric -n exits 1 with GNU message', async () => {
    const h = makeIO({ args: ['head', '-n', 'abc'], stdinText: 'a\nb\n' });
    expect(await headCommand(h.io)).toBe(1);
    expect(h.err()).toBe('head: invalid number of lines: ‘abc’\n');
  });

  test('non-numeric -c exits 1 with GNU message', async () => {
    const h = makeIO({ args: ['head', '-c', 'xyz'], stdinText: 'a\nb\n' });
    expect(await headCommand(h.io)).toBe(1);
    expect(h.err()).toBe('head: invalid number of bytes: ‘xyz’\n');
  });

  test('lowercase g suffix is invalid (only uppercase G)', async () => {
    const h = makeIO({ args: ['head', '-c', '1g'], stdinText: 'a\n' });
    expect(await headCommand(h.io)).toBe(1);
    expect(h.err()).toBe('head: invalid number of bytes: ‘1g’\n');
  });

  // ── legacy -N is operand-aware (does not corrupt -n -3) ───────────────────
  test('legacy -N with a following negative -n value is not misread', async () => {
    // `head -n -3` must treat -3 as the (negative) value of -n, not legacy -3.
    const h = makeIO({ args: ['head', '-n', '-3'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await headCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n'); // all but last 3
  });
});
