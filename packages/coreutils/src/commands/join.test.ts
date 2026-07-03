import { expect, test, describe } from 'vitest';
import { joinCommand } from './join.ts';
import { makeIO } from './_testio.ts';

describe('join', () => {
  test('joins on the common first field (whitespace default)', async () => {
    const h = makeIO({
      args: ['join', '/1', '/2'],
      files: { '/1': '1 a\n2 b\n', '/2': '1 x\n3 z\n' },
    });
    expect(await joinCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1 a x\n');
  });

  test('multiple matches join in order', async () => {
    const h = makeIO({
      args: ['join', '/1', '/2'],
      files: { '/1': '1 a\n2 b\n3 c\n', '/2': '2 y\n3 z\n' },
    });
    await joinCommand(h.io);
    expect(h.out()).toBe('2 b y\n3 c z\n');
  });

  test('-t, joins CSV with a comma separator', async () => {
    const h = makeIO({
      args: ['join', '-t,', '/1', '/2'],
      files: { '/1': '1,a\n2,b\n', '/2': '1,x\n2,y\n' },
    });
    await joinCommand(h.io);
    expect(h.out()).toBe('1,a,x\n2,b,y\n');
  });

  test('-1 2 -2 1 joins on different fields', async () => {
    const h = makeIO({
      args: ['join', '-1', '2', '-2', '1', '/1', '/2'],
      files: { '/1': 'a 1\nb 2\n', '/2': '1 x\n2 y\n' },
    });
    await joinCommand(h.io);
    expect(h.out()).toBe('1 a x\n2 b y\n');
  });

  test('no common keys yields no output', async () => {
    const h = makeIO({
      args: ['join', '/1', '/2'],
      files: { '/1': '1 a\n', '/2': '2 b\n' },
    });
    expect(await joinCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  const OUT = { '/1': '1 a\n2 b\n4 d\n', '/2': '1 x\n3 z\n4 w\n' };

  describe('-a (outer)', () => {
    test('-a1 left outer', async () => {
      const h = makeIO({ args: ['join', '-a1', '/1', '/2'], files: OUT });
      expect(await joinCommand(h.io)).toBe(0);
      expect(h.out()).toBe('1 a x\n2 b\n4 d w\n');
    });
    test('-a2 right outer', async () => {
      const h = makeIO({ args: ['join', '-a2', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 a x\n3 z\n4 d w\n');
    });
    test('-a1 -a2 full outer', async () => {
      const h = makeIO({ args: ['join', '-a1', '-a2', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 a x\n2 b\n3 z\n4 d w\n');
    });
  });

  describe('-v (unpairable only)', () => {
    test('-v1', async () => {
      const h = makeIO({ args: ['join', '-v1', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('2 b\n');
    });
    test('-v2', async () => {
      const h = makeIO({ args: ['join', '-v2', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('3 z\n');
    });
  });

  describe('-o / -e', () => {
    test('-o field list', async () => {
      const h = makeIO({ args: ['join', '-o', '1.1 1.2 2.2', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 a x\n4 d w\n');
    });
    test('-a1 -e fills the absent side', async () => {
      const h = makeIO({ args: ['join', '-a1', '-e', 'MISSING', '-o', '1.1 1.2 2.2', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 a x\n2 b MISSING\n4 d w\n');
    });
    test('-o auto', async () => {
      const h = makeIO({ args: ['join', '-o', 'auto', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 a x\n4 d w\n');
    });
    test('-e fills an out-of-range -o field', async () => {
      const h = makeIO({ args: ['join', '-e', 'NONE', '-o', '1.1 1.3', '/1', '/2'], files: OUT });
      await joinCommand(h.io);
      expect(h.out()).toBe('1 NONE\n4 NONE\n');
    });
  });

  test('-i ignores case but prints file1 key verbatim', async () => {
    const h = makeIO({ args: ['join', '-i', '/1', '/2'], files: { '/1': 'A x\nb y\n', '/2': 'a 1\nB 2\n' } });
    await joinCommand(h.io);
    expect(h.out()).toBe('A x 1\nb y 2\n');
  });

  test('-j joins on the same field in both files', async () => {
    const h = makeIO({ args: ['join', '-j', '2', '/1', '/2'], files: { '/1': 'a 1\nb 2\n', '/2': 'x 1\ny 2\n' } });
    await joinCommand(h.io);
    expect(h.out()).toBe('1 a x\n2 b y\n');
  });

  describe('check-order', () => {
    test('default: unsorted-but-unpairable diagnoses and exits 1', async () => {
      const h = makeIO({ args: ['join', '/1', '/2'], files: { '/1': '3 a\n1 b\n', '/2': '1 x\n3 z\n' } });
      expect(await joinCommand(h.io)).toBe(1);
      expect(h.out()).toBe('3 a z\n');
      expect(h.err()).toBe('join: /1:2: is not sorted: 1 b\njoin: input is not in sorted order\n');
    });
    test('default: fully-pairable unsorted input passes silently', async () => {
      const h = makeIO({ args: ['join', '/1', '/2'], files: { '/1': '2 a\n1 b\n', '/2': '2 x\n1 y\n' } });
      expect(await joinCommand(h.io)).toBe(0);
      expect(h.out()).toBe('2 a x\n1 b y\n');
      expect(h.err()).toBe('');
    });
    test('--check-order aborts immediately with no summary line', async () => {
      const h = makeIO({ args: ['join', '--check-order', '/1', '/2'], files: { '/1': '3 a\n1 b\n', '/2': '1 x\n3 z\n' } });
      expect(await joinCommand(h.io)).toBe(1);
      expect(h.out()).toBe('');
      expect(h.err()).toBe('join: /1:2: is not sorted: 1 b\n');
    });
    test('--nocheck-order suppresses the diagnostic', async () => {
      const h = makeIO({ args: ['join', '--nocheck-order', '/1', '/2'], files: { '/1': '3 a\n1 b\n', '/2': '1 x\n3 z\n' } });
      expect(await joinCommand(h.io)).toBe(0);
      expect(h.out()).toBe('3 a z\n');
      expect(h.err()).toBe('');
    });
  });

  test('duplicate keys fan out (cross product)', async () => {
    const h = makeIO({ args: ['join', '/1', '/2'], files: { '/1': '1 a\n1 b\n', '/2': '1 x\n1 y\n' } });
    await joinCommand(h.io);
    expect(h.out()).toBe('1 a x\n1 a y\n1 b x\n1 b y\n');
  });

  test('unknown flag exits 1', async () => {
    const h = makeIO({ args: ['join', '-Q', '/1', '/2'], files: { '/1': '1 a\n', '/2': '1 x\n' } });
    expect(await joinCommand(h.io)).toBe(1);
    expect(h.err()).toContain('join: invalid option -- \'Q\'');
  });
});
