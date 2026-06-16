import { expect, test, describe } from 'vitest';
import { rmCommand } from './rm.ts';
import { makeIO } from './_testio.ts';

describe('rm', () => {
  test('removes a file', async () => {
    const h = makeIO({ args: ['rm', '/f.txt'], files: { '/f.txt': 'x' } });
    expect(await rmCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/f.txt')).rejects.toThrow();
  });

  test('missing file errors without -f', async () => {
    const h = makeIO({ args: ['rm', '/missing'] });
    expect(await rmCommand(h.io)).toBe(1);
    expect(h.err()).toContain('No such file');
  });

  test('-f ignores missing file', async () => {
    const h = makeIO({ args: ['rm', '-f', '/missing'] });
    expect(await rmCommand(h.io)).toBe(0);
    expect(h.err()).toBe('');
  });

  test('refuses directory without -r', async () => {
    const h = makeIO({ args: ['rm', '/d'], files: { '/d/x': 'x' } });
    expect(await rmCommand(h.io)).toBe(1);
    expect(h.err()).toContain('Is a directory');
  });

  test('-r removes a tree', async () => {
    const h = makeIO({ args: ['rm', '-r', '/d'], files: { '/d/a': 'a', '/d/sub/b': 'b' } });
    expect(await rmCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/d')).rejects.toThrow();
  });

  test('-rf combined flag', async () => {
    const h = makeIO({ args: ['rm', '-rf', '/d'], files: { '/d/a': 'a' } });
    expect(await rmCommand(h.io)).toBe(0);
  });

  test('-d removes empty directory', async () => {
    const h = makeIO({ args: ['rm', '-d', '/d'] });
    await h.fs.mkdir('/d');
    expect(await rmCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/d')).rejects.toThrow();
  });
});
