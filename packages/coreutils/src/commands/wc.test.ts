import { expect, test, describe } from 'vitest';
import { wcCommand } from './wc.ts';
import { makeIO } from './_test-io.ts';

describe('wc', () => {
  test('default lines/words/bytes from stdin', async () => {
    const h = makeIO({ args: ['wc'], stdinText: 'one two\nthree\n' });
    expect(await wcCommand(h.io)).toBe(0);
    // 2 lines, 3 words, 14 bytes
    expect(h.out()).toBe('      2      3     14\n');
  });

  test('-l only counts lines', async () => {
    const h = makeIO({ args: ['wc', '-l'], stdinText: 'a\nb\nc\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      3\n');
  });

  test('-w only counts words', async () => {
    const h = makeIO({ args: ['wc', '-w'], stdinText: 'a b  c\n' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      3\n');
  });

  test('-c counts bytes, -m counts chars (multibyte)', async () => {
    const hc = makeIO({ args: ['wc', '-c'], stdinText: 'café\n' });
    expect(await wcCommand(hc.io)).toBe(0);
    expect(hc.out()).toBe('      6\n'); // é = 2 bytes + 'caf' + newline = 6

    const hm = makeIO({ args: ['wc', '-m'], stdinText: 'café\n' });
    expect(await wcCommand(hm.io)).toBe(0);
    expect(hm.out()).toBe('      5\n'); // 5 code points
  });

  test('reads file with name label', async () => {
    const h = makeIO({ args: ['wc', '-l', '/a'], files: { '/a': 'x\ny\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      2 /a\n');
  });

  test('multiple files emit a total line', async () => {
    const h = makeIO({ args: ['wc', '-l', '/a', '/b'], files: { '/a': 'x\n', '/b': 'y\nz\n' } });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      1 /a\n      2 /b\n      3 total\n');
  });

  test('empty input is all zeros', async () => {
    const h = makeIO({ args: ['wc'], stdinText: '' });
    expect(await wcCommand(h.io)).toBe(0);
    expect(h.out()).toBe('      0      0      0\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['wc', '/missing'] });
    expect(await wcCommand(h.io)).toBe(1);
    expect(h.err()).toContain('wc: /missing:');
  });
});
