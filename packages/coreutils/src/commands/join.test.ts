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
});
