import { expect, test, describe } from 'vitest';
import { touchCommand } from './touch.ts';
import { makeIO } from './_testio.ts';

describe('touch', () => {
  test('creates an empty file', async () => {
    const h = makeIO({ args: ['touch', '/new.txt'] });
    expect(await touchCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/new.txt')).type).toBe('file');
    expect(Number((await h.fs.stat('/new.txt')).size)).toBe(0);
  });

  test('does not truncate existing file', async () => {
    const h = makeIO({ args: ['touch', '/f.txt'], files: { '/f.txt': 'keep' } });
    expect(await touchCommand(h.io)).toBe(0);
    expect(Number((await h.fs.stat('/f.txt')).size)).toBe(4);
  });

  test('-c does not create', async () => {
    const h = makeIO({ args: ['touch', '-c', '/missing.txt'] });
    expect(await touchCommand(h.io)).toBe(0);
    await expect(async () => h.fs.stat('/missing.txt')).rejects.toThrow();
  });

  test('updates mtime', async () => {
    const old = new Date(2000, 0, 1);
    const h = makeIO({ args: ['touch', '/f.txt'], files: { '/f.txt': { content: 'x', mtime: old } } });
    await touchCommand(h.io);
    expect((await h.fs.stat('/f.txt')).mtime.getTime()).toBeGreaterThan(old.getTime());
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['touch'] });
    expect(await touchCommand(h.io)).toBe(1);
  });
});
