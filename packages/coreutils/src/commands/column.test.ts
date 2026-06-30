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

  test('column fills column-major (down then across)', async () => {
    const h = makeIO({ args: ['column', '/in'], files: { '/in': 'one\ntwo\nthree\nfour\nfive\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    // 5 entries, widths {one:3,two:3,three:5,four:4,five:4}.
    // At width 80 all 5 fit on one line → cols=5, rows=1 → "one  two  three  four  five\n"
    // (each col padded to its own width + 2 gutter; last col unpadded).
    expect(h.out()).toBe('one  two  three  four  five\n');
  });

  test('column column-major order with multiple rows', async () => {
    // Force 2 rows: 6 entries each 30 chars wide → at 80 cols only 2 columns fit
    // (30+2 + 30 = 62 ≤ 80; a 3rd column 30+2+30+2+30 = 94 > 80). rows = ceil(6/2)=3.
    // Column-major: col0 = entries[0..2], col1 = entries[3..5].
    // Row r prints entries[0*3+r] then entries[1*3+r].
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(30));
    const h = makeIO({ args: ['column', '/in'], files: { '/in': entries.join('\n') + '\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    // col0 width = 30, gutter 2 → col0 cell = 32 wide; col1 unpadded.
    const A = 'a'.repeat(30), B = 'b'.repeat(30), C = 'c'.repeat(30), D = 'd'.repeat(30), E = 'e'.repeat(30), F = 'f'.repeat(30);
    expect(h.out()).toBe(
      A.padEnd(32) + D + '\n' +
      B.padEnd(32) + E + '\n' +
      C.padEnd(32) + F + '\n',
    );
  });
});
