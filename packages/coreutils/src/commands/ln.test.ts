import { expect, test, describe } from 'vitest';
import { lnCommand } from './ln.ts';
import { makeIO } from './_testio.ts';

describe('ln', () => {
  test('-s creates a symlink', async () => {
    const h = makeIO({ args: ['ln', '-s', '/target', '/link'], files: { '/target': 'x' } });
    expect(await lnCommand(h.io)).toBe(0);
    expect(h.fs.readlink('/link')).toBe('/target');
  });

  test('hard link shares content', async () => {
    const h = makeIO({ args: ['ln', '/a', '/b'], files: { '/a': 'shared' } });
    expect(await lnCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/b')).type).toBe('file');
    expect(Number((await h.fs.stat('/b')).size)).toBe(6);
  });

  test('-f replaces existing link', async () => {
    const h = makeIO({ args: ['ln', '-sf', '/new', '/link'], files: { '/new': 'n', '/link': 'old' } });
    expect(await lnCommand(h.io)).toBe(0);
    expect(h.fs.readlink('/link')).toBe('/new');
  });

  test('link into directory uses basename', async () => {
    const h = makeIO({ args: ['ln', '-s', '/some/target', '/d'], files: { '/d/.keep': '' } });
    expect(await lnCommand(h.io)).toBe(0);
    expect(h.fs.readlink('/d/target')).toBe('/some/target');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['ln'] });
    expect(await lnCommand(h.io)).toBe(1);
  });

  test('error without -f when link exists', async () => {
    const h = makeIO({ args: ['ln', '-s', '/t', '/link'], files: { '/link': 'x' } });
    expect(await lnCommand(h.io)).toBe(1);
    expect(h.err()).toContain('failed to create link');
  });
});
