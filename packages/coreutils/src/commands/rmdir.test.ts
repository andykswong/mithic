import { expect, test, describe } from 'vitest';
import { rmdirCommand } from './rmdir.ts';
import { makeIO } from './_testio.ts';

describe('rmdir', () => {
  test('removes empty directory', async () => {
    const h = makeIO({ args: ['rmdir', '/d'] });
    await h.fs.mkdir('/d');
    expect(await rmdirCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/d')).rejects.toThrow();
  });

  test('fails on non-empty', async () => {
    const h = makeIO({ args: ['rmdir', '/d'], files: { '/d/x': 'hi' } });
    expect(await rmdirCommand(h.io)).toBe(1);
    expect(h.err()).toContain('failed to remove');
  });

  test('-p removes empty parents', async () => {
    const h = makeIO({ args: ['rmdir', '-p', '/a/b/c'] });
    await h.fs.mkdir('/a'); await h.fs.mkdir('/a/b'); await h.fs.mkdir('/a/b/c');
    expect(await rmdirCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/a')).rejects.toThrow();
  });

  test('-p stops at non-empty parent', async () => {
    const h = makeIO({ args: ['rmdir', '-p', '/a/b/c'] });
    await h.fs.mkdir('/a'); await h.fs.mkdir('/a/b'); await h.fs.mkdir('/a/b/c');
    await h.fs.open('/a/keep', { create: true, write: true });
    expect(await rmdirCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/a')).type).toBe('directory');
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['rmdir'] });
    expect(await rmdirCommand(h.io)).toBe(1);
  });
});
