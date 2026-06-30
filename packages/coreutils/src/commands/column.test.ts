import { expect, test, describe } from 'vitest';
import { columnCommand } from './column.ts';
import { makeIO } from './_testio.ts';

describe('column -t', () => {
  test('aligns columns with a 2-space gutter', async () => {
    const h = makeIO({ args: ['column', '-t', '/in'], files: { '/in': 'a bb\nccc d\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a    bb\nccc  d\n');
  });

  test('-s, splits on a comma', async () => {
    const h = makeIO({ args: ['column', '-t', '-s,', '/in'], files: { '/in': 'a,bb\nccc,d\n' } });
    await columnCommand(h.io);
    expect(h.out()).toBe('a    bb\nccc  d\n');
  });

  test('ragged rows (varying field counts) align by column', async () => {
    const h = makeIO({ args: ['column', '-t', '/in'], files: { '/in': 'one two three\nx y\n' } });
    await columnCommand(h.io);
    expect(h.out()).toBe('one  two  three\nx    y\n');
  });

  test('reads stdin', async () => {
    const h = makeIO({ args: ['column', '-t'], stdinText: 'a bb\nccc d\n' });
    await columnCommand(h.io);
    expect(h.out()).toBe('a    bb\nccc  d\n');
  });
});

describe('column (fill mode, no -t)', () => {
  test('fills entries across an 80-column line', async () => {
    // Short single-token lines pack onto fill rows (documented 80-col model).
    const h = makeIO({ args: ['column'], stdinText: 'a\nb\nc\n' });
    expect(await columnCommand(h.io)).toBe(0);
    // All three short entries fit on one filled line.
    expect(h.out().trimEnd().split('\n').length).toBe(1);
    expect(h.out()).toContain('a');
    expect(h.out()).toContain('c');
  });
});
