import { expect, test, describe } from 'vitest';
import { sumCommand } from './sum.ts';
import { bsdSum } from './cksum.ts';
import { makeIO } from './_test-io.ts';

describe('sum (BSD checksum + block count)', () => {
  test('bsdSum computes the rotating 16-bit checksum', () => {
    expect(bsdSum(new TextEncoder().encode('hello\n'))).toEqual({ checksum: 36979, blocks: 1 });
    expect(bsdSum(new TextEncoder().encode('abc'))).toEqual({ checksum: 16556, blocks: 1 });
  });

  test('blocks are counted in 512-byte units', () => {
    expect(bsdSum(new Uint8Array(513)).blocks).toBe(2);
    expect(bsdSum(new Uint8Array(512)).blocks).toBe(1);
    expect(bsdSum(new Uint8Array(0)).blocks).toBe(0);
  });

  test('prints checksum and block count for stdin', async () => {
    const h = makeIO({ args: ['sum'], stdinText: 'hello\n' });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('36979     1\n');
  });

  test('prints the filename for a file operand', async () => {
    const h = makeIO({ args: ['sum', '/f.txt'], files: { '/f.txt': 'hello\n' } });
    expect(await sumCommand(h.io)).toBe(0);
    expect(h.out()).toBe('36979     1 /f.txt\n');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['sum', '/missing'] });
    expect(await sumCommand(h.io)).toBe(1);
    expect(h.err()).toContain('sum:');
  });
});
