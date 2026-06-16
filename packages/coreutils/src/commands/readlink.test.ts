import { expect, test, describe } from 'vitest';
import { readlinkCommand } from './readlink.ts';
import { makeIO } from './_testio.ts';

describe('readlink', () => {
  test('prints symlink target', async () => {
    const h = makeIO({ args: ['readlink', '/link'], files: { '/target': 'x' } });
    await h.fs.symlink('/target', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/target\n');
  });

  test('-n omits trailing newline', async () => {
    const h = makeIO({ args: ['readlink', '-n', '/link'] });
    await h.fs.symlink('/t', '/link');
    await readlinkCommand(h.io);
    expect(h.out()).toBe('/t');
  });

  test('-f canonicalizes through symlink', async () => {
    const h = makeIO({ args: ['readlink', '-f', '/link'], files: { '/dir/file': 'x' } });
    await h.fs.symlink('/dir/file', '/link');
    expect(await readlinkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/dir/file\n');
  });

  test('non-link returns 1 with no output', async () => {
    const h = makeIO({ args: ['readlink', '/f'], files: { '/f': 'x' } });
    expect(await readlinkCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['readlink'] });
    expect(await readlinkCommand(h.io)).toBe(1);
  });
});
