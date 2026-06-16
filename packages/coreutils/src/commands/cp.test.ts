import { expect, test, describe } from 'vitest';
import { cpCommand } from './cp.ts';
import { makeIO } from './_testio.ts';

const read = async (fs: ReturnType<typeof makeIO>['fs'], path: string): Promise<string> => {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 20);
  await fs.close(h);
  return new TextDecoder().decode(data);
};

describe('cp', () => {
  test('copies a file', async () => {
    const h = makeIO({ args: ['cp', '/a.txt', '/b.txt'], files: { '/a.txt': 'hello' } });
    expect(await cpCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/b.txt')).toBe('hello');
    expect(await read(h.fs, '/a.txt')).toBe('hello');
  });

  test('copies into an existing directory', async () => {
    const h = makeIO({ args: ['cp', '/a.txt', '/d'], files: { '/a.txt': 'x', '/d/.keep': '' } });
    expect(await cpCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/d/a.txt')).toBe('x');
  });

  test('multiple sources require directory dest', async () => {
    const h = makeIO({ args: ['cp', '/a', '/b', '/c'], files: { '/a': '1', '/b': '2' } });
    expect(await cpCommand(h.io)).toBe(1);
    expect(h.err()).toContain('not a directory');
  });

  test('refuses directory without -r', async () => {
    const h = makeIO({ args: ['cp', '/d', '/e'], files: { '/d/x': 'x' } });
    expect(await cpCommand(h.io)).toBe(1);
    expect(h.err()).toContain('Is a directory');
  });

  test('-r copies a tree', async () => {
    const h = makeIO({ args: ['cp', '-r', '/d', '/e'], files: { '/d/a': 'A', '/d/sub/b': 'B' } });
    expect(await cpCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/e/a')).toBe('A');
    expect(await read(h.fs, '/e/sub/b')).toBe('B');
  });

  test('-p preserves mode', async () => {
    const h = makeIO({ args: ['cp', '-p', '/a', '/b'], files: { '/a': { content: 'x', mode: 0o600 } } });
    expect(await cpCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/b')).mode & 0o777).toBe(0o600);
  });

  test('missing operands', async () => {
    const h = makeIO({ args: ['cp', '/only'] });
    expect(await cpCommand(h.io)).toBe(1);
  });
});
