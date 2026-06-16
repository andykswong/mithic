import { expect, test, describe } from 'vitest';
import { mkdirCommand } from './mkdir.ts';
import { makeIO } from './_testio.ts';

describe('mkdir', () => {
  test('creates a directory', async () => {
    const h = makeIO({ args: ['mkdir', '/d'] });
    expect(await mkdirCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/d')).type).toBe('directory');
  });

  test('fails without -p when parent missing', async () => {
    const h = makeIO({ args: ['mkdir', '/a/b/c'] });
    expect(await mkdirCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cannot create directory');
  });

  test('-p creates parents', async () => {
    const h = makeIO({ args: ['mkdir', '-p', '/a/b/c'] });
    expect(await mkdirCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/a/b/c')).type).toBe('directory');
  });

  test('-p is idempotent', async () => {
    const h = makeIO({ args: ['mkdir', '-p', '/a/b'], files: { '/a/b/x': 'hi' } });
    expect(await mkdirCommand(h.io)).toBe(0);
  });

  test('-m sets mode', async () => {
    const h = makeIO({ args: ['mkdir', '-m', '700', '/d'] });
    expect(await mkdirCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/d')).mode & 0o777).toBe(0o700);
  });

  test('invalid mode errors', async () => {
    const h = makeIO({ args: ['mkdir', '-m', 'zzz', '/d'] });
    expect(await mkdirCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid mode');
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['mkdir'] });
    expect(await mkdirCommand(h.io)).toBe(1);
  });
});
