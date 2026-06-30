import { expect, test, describe } from 'vitest';
import { duCommand } from './du.ts';
import { makeIO } from './_testio.ts';

// Model under test (documented in du.ts header): block size = ceil(byte-sum /
// 1024). Real GNU st_blocks accounting is not reproducible on a virtual FS.
const A = 'a'.repeat(2048);
const B = 'b'.repeat(1024);
const tree = { '/d/a': A, '/d/sub/b': B };

describe('du', () => {
  test('-s prints one cumulative total per argument', async () => {
    const h = makeIO({ args: ['du', '-s', '/d'], files: tree });
    expect(await duCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\t/d\n');
  });

  test('default lists each subdir (children first) then the argument', async () => {
    const h = makeIO({ args: ['du', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('1\t/d/sub\n3\t/d\n');
  });

  test('-a includes individual files', async () => {
    const h = makeIO({ args: ['du', '-a', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('2\t/d/a\n1\t/d/sub/b\n1\t/d/sub\n3\t/d\n');
  });

  test('-h human-readable', async () => {
    const h = makeIO({ args: ['du', '-sh', '/d'], files: tree });
    await duCommand(h.io);
    expect(h.out()).toBe('3.0K\t/d\n');
  });

  test('ceil: 1500 bytes rounds up to 2 KiB', async () => {
    const h = makeIO({ args: ['du', '-s', '/f'], files: { '/f': 'x'.repeat(1500) } });
    await duCommand(h.io);
    expect(h.out()).toBe('2\t/f\n');
  });
});
