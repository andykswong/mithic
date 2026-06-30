import { expect, test, describe } from 'vitest';
import { splitCommand } from './split.ts';
import { makeIO } from './_testio.ts';

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

async function readBack(fs: { stat: (p: string) => Promise<unknown>; open: (p: string, f: Record<string, boolean>) => Promise<unknown>; read: (h: unknown, o: number, l: number) => Promise<Uint8Array> }, path: string): Promise<string> {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 20);
  return dec(new Uint8Array(data));
}

describe('split', () => {
  test('-l 2 splits a 5-line file into xaa/xab/xac', async () => {
    const h = makeIO({ args: ['split', '-l', '2', '/in'], files: { '/in': 'a\nb\nc\nd\ne\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('a\nb\n');
    expect(await readBack(h.fs as never, '/xab')).toBe('c\nd\n');
    expect(await readBack(h.fs as never, '/xac')).toBe('e\n');
  });

  test('-b 4 splits by byte count', async () => {
    const h = makeIO({ args: ['split', '-b', '4', '/in'], files: { '/in': 'abcdefghij' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('abcd');
    expect(await readBack(h.fs as never, '/xab')).toBe('efgh');
    expect(await readBack(h.fs as never, '/xac')).toBe('ij');
  });

  test('-b 1k accepts the K suffix', async () => {
    const big = 'x'.repeat(2048 + 5);
    const h = makeIO({ args: ['split', '-b', '1k', '/in'], files: { '/in': big } });
    expect(await splitCommand(h.io)).toBe(0);
    expect((await readBack(h.fs as never, '/xaa')).length).toBe(1024);
    expect((await readBack(h.fs as never, '/xab')).length).toBe(1024);
    expect((await readBack(h.fs as never, '/xac')).length).toBe(5);
  });

  test('custom prefix', async () => {
    const h = makeIO({ args: ['split', '-l', '1', '/in', 'part_'], files: { '/in': 'a\nb\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/part_aa')).toBe('a\n');
    expect(await readBack(h.fs as never, '/part_ab')).toBe('b\n');
  });

  test('reads stdin when no input operand', async () => {
    const h = makeIO({ args: ['split', '-l', '1'], stdinText: 'one\ntwo\n' });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('one\n');
    expect(await readBack(h.fs as never, '/xab')).toBe('two\n');
  });
});
