import { expect, test, describe } from 'vitest';
import { copyCommand } from './copy.ts';
import { makeIO } from './_testio.ts';

const readBytes = async (fs: ReturnType<typeof makeIO>['fs'], path: string): Promise<Uint8Array> => {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 20);
  await fs.close(h);
  return new Uint8Array(data);
};

describe('copy', () => {
  test('copies a file verbatim by path-arg', async () => {
    const h = makeIO({ args: ['copy', '/a.txt', '/b.txt'], files: { '/a.txt': 'hello' } });
    expect(await copyCommand(h.io)).toBe(0);
    expect(new TextDecoder().decode(await readBytes(h.fs, '/b.txt'))).toBe('hello');
  });

  test('preserves arbitrary binary bytes (NUL/high-bit)', async () => {
    const payload = new Uint8Array([0, 255, 128, 10, 0, 1]);
    const h = makeIO({ args: ['copy', '/in.bin', '/out.bin'], files: { '/in.bin': payload } });
    expect(await copyCommand(h.io)).toBe(0);
    expect(Array.from(await readBytes(h.fs, '/out.bin'))).toEqual(Array.from(payload));
  });

  test('resolves cwd-relative source and destination', async () => {
    const h = makeIO({ args: ['copy', 'in', 'out'], cwd: '/work', files: { '/work/in': 'x' } });
    expect(await copyCommand(h.io)).toBe(0);
    expect(new TextDecoder().decode(await readBytes(h.fs, '/work/out'))).toBe('x');
  });

  test('creates missing intermediate directories for the destination', async () => {
    const h = makeIO({ args: ['copy', '/a', '/d/sub/b'], files: { '/a': 'y' } });
    expect(await copyCommand(h.io)).toBe(0);
    expect(new TextDecoder().decode(await readBytes(h.fs, '/d/sub/b'))).toBe('y');
  });

  test('copies an empty file', async () => {
    const h = makeIO({ args: ['copy', '/empty', '/out'], files: { '/empty': '' } });
    expect(await copyCommand(h.io)).toBe(0);
    expect((await readBytes(h.fs, '/out')).byteLength).toBe(0);
  });

  test('missing operands error with a non-zero exit', async () => {
    const h = makeIO({ args: ['copy', '/a'], files: { '/a': 'x' } });
    expect(await copyCommand(h.io)).toBe(1);
    expect(h.err()).toContain('copy');
  });

  test('a missing source file errors', async () => {
    const h = makeIO({ args: ['copy', '/nope', '/out'] });
    expect(await copyCommand(h.io)).toBe(1);
    expect(h.err()).toContain('copy');
  });
});
