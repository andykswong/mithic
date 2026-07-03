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

  // ── large size suffixes ───────────────────────────────────────────────────
  test('-b 1G accepts the G suffix (single piece for small input)', async () => {
    const h = makeIO({ args: ['split', '-b', '1G', '/in'], files: { '/in': '0123456789' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('0123456789');
  });

  test('-b 1T / 1P accept the T/P suffixes', async () => {
    for (const suf of ['1T', '1P']) {
      const h = makeIO({ args: ['split', '-b', suf, '/in'], files: { '/in': 'abc' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('abc');
    }
  });

  test('lowercase g suffix is an invalid byte count', async () => {
    const h = makeIO({ args: ['split', '-b', '1g', '/in'], files: { '/in': 'abc' } });
    expect(await splitCommand(h.io)).toBe(1);
    expect(h.err()).toBe('split: invalid number of bytes: ‘1g’\n');
  });

  // ── -a suffix length ──────────────────────────────────────────────────────
  test('-a 3 uses a 3-letter suffix', async () => {
    const h = makeIO({ args: ['split', '-a', '3', '-b', '3', '/in'], files: { '/in': 'abcdefghij' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaaa')).toBe('abc');
    expect(await readBack(h.fs as never, '/xaab')).toBe('def');
    expect(await readBack(h.fs as never, '/xaac')).toBe('ghi');
    expect(await readBack(h.fs as never, '/xaad')).toBe('j');
  });

  // ── -n chunk modes ────────────────────────────────────────────────────────
  test('-n 3 splits into 3 byte-balanced pieces (remainder to the front)', async () => {
    const h = makeIO({ args: ['split', '-n', '3', '/in'], files: { '/in': '0123456789' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('0123'); // 4
    expect(await readBack(h.fs as never, '/xab')).toBe('456');  // 3
    expect(await readBack(h.fs as never, '/xac')).toBe('789');  // 3
  });

  test('-n l/3 splits on line boundaries', async () => {
    const h = makeIO({ args: ['split', '-n', 'l/3', '/in'], files: { '/in': 'a\nb\nc\nd\ne\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('a\nb\n');
    expect(await readBack(h.fs as never, '/xab')).toBe('c\nd\n');
    expect(await readBack(h.fs as never, '/xac')).toBe('e\n');
  });

  test('-n r/3 round-robins lines', async () => {
    const h = makeIO({ args: ['split', '-n', 'r/3', '/in'], files: { '/in': 'a\nb\nc\nd\ne\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('a\nd\n');
    expect(await readBack(h.fs as never, '/xab')).toBe('b\ne\n');
    expect(await readBack(h.fs as never, '/xac')).toBe('c\n');
  });

  test('-n K/N writes only the K-th chunk to stdout', async () => {
    const h = makeIO({ args: ['split', '-n', '2/3', '/in'], files: { '/in': '0123456789' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(h.out()).toBe('456');
  });

  // ── -C line-bounded byte size ─────────────────────────────────────────────
  test('-C 4 fills up to N bytes on line boundaries; long lines are broken', async () => {
    const h = makeIO({ args: ['split', '-C', '4', '/in'], files: { '/in': 'aaa\nbbbbbbb\ncc\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(await readBack(h.fs as never, '/xaa')).toBe('aaa\n');
    expect(await readBack(h.fs as never, '/xab')).toBe('bbbb');
    expect(await readBack(h.fs as never, '/xac')).toBe('bbb\n');
    expect(await readBack(h.fs as never, '/xad')).toBe('cc\n');
  });

  // ── --verbose ─────────────────────────────────────────────────────────────
  test('--verbose announces each created file', async () => {
    const h = makeIO({ args: ['split', '--verbose', '-b', '3', '/in'], files: { '/in': '0123456789' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(h.out()).toBe('creating file \'xaa\'\ncreating file \'xab\'\ncreating file \'xac\'\ncreating file \'xad\'\n');
  });

  // ── conflicting modes ─────────────────────────────────────────────────────
  test('specifying two split modes is an error', async () => {
    const h = makeIO({ args: ['split', '-b', '2', '-l', '3', '/in'], files: { '/in': 'ab' } });
    expect(await splitCommand(h.io)).toBe(1);
    expect(h.err()).toBe('split: cannot split in more than one way\nTry \'split --help\' for more information.\n');
  });
});
