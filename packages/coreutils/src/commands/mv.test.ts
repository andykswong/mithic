import { expect, test, describe } from 'vitest';
import { mvCommand } from './mv.ts';
import { makeIO } from './_testio.ts';

const read = async (fs: ReturnType<typeof makeIO>['fs'], path: string): Promise<string> => {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 20);
  await fs.close(h);
  return new TextDecoder().decode(data);
};

describe('mv', () => {
  test('renames a file', async () => {
    const h = makeIO({ args: ['mv', '/a.txt', '/b.txt'], files: { '/a.txt': 'hi' } });
    expect(await mvCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/b.txt')).toBe('hi');
    await expect(async () => h.fs.stat('/a.txt')).rejects.toThrow();
  });

  test('moves into a directory', async () => {
    const h = makeIO({ args: ['mv', '/a.txt', '/d'], files: { '/a.txt': 'x', '/d/.keep': '' } });
    expect(await mvCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/d/a.txt')).toBe('x');
  });

  test('multiple sources need directory dest', async () => {
    const h = makeIO({ args: ['mv', '/a', '/b', '/c'], files: { '/a': '1', '/b': '2' } });
    expect(await mvCommand(h.io)).toBe(1);
    expect(h.err()).toContain('not a directory');
  });

  test('-n keeps existing destination', async () => {
    const h = makeIO({ args: ['mv', '-n', '/a', '/b'], files: { '/a': 'new', '/b': 'old' } });
    expect(await mvCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/b')).toBe('old');
  });

  test('missing source reports error', async () => {
    const h = makeIO({ args: ['mv', '/missing', '/dst'] });
    expect(await mvCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cannot move');
  });

  test('missing operands', async () => {
    const h = makeIO({ args: ['mv', '/only'] });
    expect(await mvCommand(h.io)).toBe(1);
  });
});
