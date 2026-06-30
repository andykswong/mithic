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
    // 5 entries; widest is "three" (5). util-linux uniform model:
    // maxlen=5, colw=5+2=7, cols=floor(80/7)=11 → capped by 5 entries, rows=ceil(5/11)=1.
    // One row, column-major: entries[0..4]. Each cell padded to colw=7 except the last.
    //   one.padEnd(7)="one    ", two.padEnd(7)="two    ", three.padEnd(7)="three  ",
    //   four.padEnd(7)="four   ", five (last, unpadded).
    expect(h.out()).toBe('one    two    three  four   five\n');
  });

  test('column column-major order with multiple rows', async () => {
    // 6 entries each 30 chars wide. util-linux uniform model: maxlen=30,
    // colw=30+2=32, cols=floor(80/32)=2, rows=ceil(6/2)=3.
    // Column-major: col0 = entries[0..2], col1 = entries[3..5].
    // Row r prints entries[0*3+r] then entries[1*3+r].
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(30));
    const h = makeIO({ args: ['column', '/in'], files: { '/in': entries.join('\n') + '\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    // uniform colw = 32; each cell padded to 32 except the last in a row.
    const A = 'a'.repeat(30), B = 'b'.repeat(30), C = 'c'.repeat(30), D = 'd'.repeat(30), E = 'e'.repeat(30), F = 'f'.repeat(30);
    expect(h.out()).toBe(
      A.padEnd(32) + D + '\n' +
      B.padEnd(32) + E + '\n' +
      C.padEnd(32) + F + '\n',
    );
  });

  test('mixed-width entries use a UNIFORM column width (util-linux model)', async () => {
    // 5 one-char entries + 1 twenty-char entry. util-linux uses ONE uniform
    // width derived from the WIDEST entry (a per-column-width model would pick a
    // different column count / widths — this case distinguishes the two).
    //   maxlen = 20, colw = 20 + 2 = 22.
    //   cols = floor(80 / 22) = 3, rows = ceil(6 / 3) = 2.
    // Column-major: col0 = entries[0..1], col1 = entries[2..3], col2 = entries[4..5].
    //   row0 = entries[0],entries[2],entries[4] = x, x, x
    //   row1 = entries[1],entries[3],entries[5] = x, x, LONGENTRY_20_CHARS__
    // Every cell padded to colw=22 except the last in each row (no trailing ws).
    const LONG = 'LONGENTRY_20_CHARS__'; // exactly 20 chars
    const entries = ['x', 'x', 'x', 'x', 'x', LONG];
    const h = makeIO({ args: ['column', '/in'], files: { '/in': entries.join('\n') + '\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      'x'.padEnd(22) + 'x'.padEnd(22) + 'x' + '\n' +
      'x'.padEnd(22) + 'x'.padEnd(22) + LONG + '\n',
    );
  });

  test('an oversized entry forces a single column (cols=1)', async () => {
    // One entry wider than 80 columns → colw > 80 → cols = max(1, 0) = 1.
    const wide = 'z'.repeat(100);
    const h = makeIO({ args: ['column', '/in'], files: { '/in': wide + '\nshort\n' } });
    expect(await columnCommand(h.io)).toBe(0);
    expect(h.out()).toBe(wide + '\nshort\n');
  });
});
