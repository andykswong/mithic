import { expect, test, describe } from 'vitest';
import { splitCommand, suffixFor } from './split.ts';
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

  // ── -n l/K/N and r/K/N: write only the K-th of N chunks to stdout ─────────
  test('-n l/2/3 writes the 2nd of 3 line-boundary chunks', async () => {
    const h = makeIO({ args: ['split', '-n', 'l/2/3', '/in'], files: { '/in': 'a\nb\nc\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });
  test('-n l/1/3 and l/3/3 select the other chunks', async () => {
    const h1 = makeIO({ args: ['split', '-n', 'l/1/3', '/in'], files: { '/in': 'a\nb\nc\n' } });
    expect(await splitCommand(h1.io)).toBe(0);
    expect(h1.out()).toBe('a\n');
    const h3 = makeIO({ args: ['split', '-n', 'l/3/3', '/in'], files: { '/in': 'a\nb\nc\n' } });
    expect(await splitCommand(h3.io)).toBe(0);
    expect(h3.out()).toBe('c\n');
  });
  test('-n r/2/3 writes the 2nd round-robin chunk', async () => {
    const h = makeIO({ args: ['split', '-n', 'r/2/3', '/in'], files: { '/in': 'a\nb\nc\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });
  test('-n r/2/3 on 6 lines: round-robin picks lines 2 and 5', async () => {
    const h = makeIO({ args: ['split', '-n', 'r/2/3', '/in'], files: { '/in': '1\n2\n3\n4\n5\n6\n' } });
    expect(await splitCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n5\n');
  });
  test('-n l/K/N rejects an out-of-range K', async () => {
    const h = makeIO({ args: ['split', '-n', 'l/4/3', '/in'], files: { '/in': 'a\nb\nc\n' } });
    expect(await splitCommand(h.io)).toBe(1);
    expect(h.err()).toContain('split: invalid chunk number: ‘4’');
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

  // ── M11: a repeated same-mode flag is an error (last-wins is wrong) ─────────
  describe('repeated same-mode flag is rejected', () => {
    const msg = 'split: cannot split in more than one way\nTry \'split --help\' for more information.\n';
    test('-b 2 -b 3 → error', async () => {
      const h = makeIO({ args: ['split', '-b', '2', '-b', '3', '/in'], files: { '/in': 'abcdef' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe(msg);
    });
    test('-l 1 -l 2 → error', async () => {
      const h = makeIO({ args: ['split', '-l', '1', '-l', '2', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe(msg);
    });
    test('-n 2 -n 3 → error', async () => {
      const h = makeIO({ args: ['split', '-n', '2', '-n', '3', '/in'], files: { '/in': 'abcdef' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe(msg);
    });
    test('-C 2 -C 3 → error', async () => {
      const h = makeIO({ args: ['split', '-C', '2', '-C', '3', '/in'], files: { '/in': 'abcdef' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe(msg);
    });
    test('single-mode -b 2 still works', async () => {
      const h = makeIO({ args: ['split', '-b', '2', '/in'], files: { '/in': 'abcd' } });
      expect(await splitCommand(h.io)).toBe(0);
    });
  });

  // ── D3: numeric / hex / additional-suffix / separator / elide / unbuffered ──
  describe('numeric & hex suffixes', () => {
    test('-d uses numeric suffixes 00,01,02', async () => {
      const h = makeIO({ args: ['split', '-d', '-l', '1', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x00')).toBe('a\n');
      expect(await readBack(h.fs as never, '/x01')).toBe('b\n');
      expect(await readBack(h.fs as never, '/x02')).toBe('c\n');
    });
    test('--numeric-suffixes=5 starts numbering at FROM', async () => {
      const h = makeIO({ args: ['split', '--numeric-suffixes=5', '-l', '1', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x05')).toBe('a\n');
      expect(await readBack(h.fs as never, '/x06')).toBe('b\n');
      expect(await readBack(h.fs as never, '/x07')).toBe('c\n');
    });
    test('-x uses hexadecimal suffixes 00..0a', async () => {
      const h = makeIO({ args: ['split', '-x', '-l', '1', '/in'], files: { '/in': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x00')).toBe('1\n');
      expect(await readBack(h.fs as never, '/x09')).toBe('10\n');
      expect(await readBack(h.fs as never, '/x0a')).toBe('11\n');
    });
    test('--hex-suffixes=10 starts hex numbering at FROM (0x10)', async () => {
      const h = makeIO({ args: ['split', '--hex-suffixes=10', '-l', '1', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x10')).toBe('a\n');
      expect(await readBack(h.fs as never, '/x11')).toBe('b\n');
      expect(await readBack(h.fs as never, '/x12')).toBe('c\n');
    });
    test('-d composes with -a suffix length', async () => {
      const h = makeIO({ args: ['split', '-d', '-a', '3', '-l', '1', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x000')).toBe('a\n');
      expect(await readBack(h.fs as never, '/x001')).toBe('b\n');
    });
  });

  describe('--additional-suffix', () => {
    test('appends the suffix to every output name', async () => {
      const h = makeIO({ args: ['split', '--additional-suffix=.txt', '-l', '1', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa.txt')).toBe('a\n');
      expect(await readBack(h.fs as never, '/xab.txt')).toBe('b\n');
    });
    test('composes with -d', async () => {
      const h = makeIO({ args: ['split', '-d', '--additional-suffix=.log', '-l', '1', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/x00.log')).toBe('a\n');
      expect(await readBack(h.fs as never, '/x01.log')).toBe('b\n');
    });
  });

  describe('-t / --separator', () => {
    test('-t : uses a custom line separator', async () => {
      const h = makeIO({ args: ['split', '-t', ':', '-l', '1', '/in'], files: { '/in': 'a:b:c:' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a:');
      expect(await readBack(h.fs as never, '/xab')).toBe('b:');
      expect(await readBack(h.fs as never, '/xac')).toBe('c:');
    });
    test('-t \\0 treats NUL as the separator', async () => {
      const h = makeIO({ args: ['split', '-t', '\\0', '-l', '1', '/in'], files: { '/in': 'a b c ' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a ');
      expect(await readBack(h.fs as never, '/xab')).toBe('b ');
      expect(await readBack(h.fs as never, '/xac')).toBe('c ');
    });
    test('--separator=: works as a long option', async () => {
      const h = makeIO({ args: ['split', '--separator=:', '-l', '1', '/in'], files: { '/in': 'a:b:' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a:');
      expect(await readBack(h.fs as never, '/xab')).toBe('b:');
    });
  });

  describe('-e / --elide-empty-files and -u', () => {
    test('-e with -n l/N drops empty chunks', async () => {
      const h = makeIO({ args: ['split', '-e', '-n', 'l/5', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('b\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('c\n');
      expect(() => h.fs.stat('/xad')).toThrow();
    });
    test('without -e, empty chunks are still created', async () => {
      const h = makeIO({ args: ['split', '-n', 'l/5', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('b\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('');
      expect(await readBack(h.fs as never, '/xad')).toBe('c\n');
      expect(await readBack(h.fs as never, '/xae')).toBe('');
    });
    test('-u is accepted as a no-op', async () => {
      const h = makeIO({ args: ['split', '-u', '-l', '1', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('b\n');
    });
  });

  // ── D4: obsolete numeric operand form `split -N` ────────────────────────────
  describe('obsolete -N line-count operand', () => {
    test('-5 on a 3-line file writes one file with all lines', async () => {
      const h = makeIO({ args: ['split', '-5', '/in'], files: { '/in': 'a\nb\nc\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('a\nb\nc\n');
    });
    test('-3 on a 12-line file writes xaa..xad', async () => {
      const h = makeIO({ args: ['split', '-3', '/in'], files: { '/in': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n' } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n');
      expect(await readBack(h.fs as never, '/xad')).toBe('10\n11\n12\n');
    });
    test('-5 combined with -l is a conflicting-mode error', async () => {
      const h = makeIO({ args: ['split', '-5', '-l', '2', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: cannot split in more than one way\nTry \'split --help\' for more information.\n');
    });
    // SP1: the obsolete -DIGITS operand is accepted anywhere before `--`, not just at position 0.
    test('trailing -5 after the INPUT operand (in12 -5)', async () => {
      const twelve = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n';
      const h = makeIO({ args: ['split', '/in', '-5'], files: { '/in': twelve } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n4\n5\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('6\n7\n8\n9\n10\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('11\n12\n');
    });
    test('-a 2 -5 in12: -DIGITS interspersed with options', async () => {
      const twelve = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n';
      const h = makeIO({ args: ['split', '-a', '2', '-5', '/in'], files: { '/in': twelve } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n4\n5\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('11\n12\n');
    });
    test('-5 -l 2 is still a conflicting-mode error', async () => {
      const h = makeIO({ args: ['split', '-5', '-l', '2', '/in'], files: { '/in': 'a\nb\n' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: cannot split in more than one way\nTry \'split --help\' for more information.\n');
    });
    // SP-MULTI: multiple obsolete -DIGITS operands are last-wins, not an error.
    const eight = '1\n2\n3\n4\n5\n6\n7\n8\n';
    test('-5 -3 in8: last -DIGITS wins (3/3/2 lines)', async () => {
      const h = makeIO({ args: ['split', '-5', '-3', '/in'], files: { '/in': eight } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('4\n5\n6\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('7\n8\n');
    });
    test('-2 -4 in8: last -DIGITS wins (4/4 lines)', async () => {
      const h = makeIO({ args: ['split', '-2', '-4', '/in'], files: { '/in': eight } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n4\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('5\n6\n7\n8\n');
      expect(() => h.fs.stat('/xac')).toThrow();
    });
    test('-3 -3 in8: repeated -DIGITS is accepted', async () => {
      const h = makeIO({ args: ['split', '-3', '-3', '/in'], files: { '/in': eight } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xaa')).toBe('1\n2\n3\n');
      expect(await readBack(h.fs as never, '/xab')).toBe('4\n5\n6\n');
      expect(await readBack(h.fs as never, '/xac')).toBe('7\n8\n');
    });
  });

  // ── SP2: fixed-width suffix exhaustion is detected (no silent clobber) ───────
  describe('output file suffixes exhausted', () => {
    test('-d -a 1 -l 11 writes x0..x9 then errors on the 11th piece', async () => {
      const lines = Array.from({ length: 120 }, (_, i) => `${i}`).join('\n') + '\n';
      const h = makeIO({ args: ['split', '-d', '-a', '1', '-l', '11', '/in'], files: { '/in': lines } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: output file suffixes exhausted\n');
      // The pieces that fit were written; the 11th did NOT clobber x0.
      expect(await readBack(h.fs as never, '/x0')).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
      expect(() => h.fs.stat('/x10')).toThrow();
    });
    test('-a 1 alpha with 30 pieces errors after xa..xz', async () => {
      const lines = Array.from({ length: 120 }, (_, i) => `${i}`).join('\n') + '\n';
      const h = makeIO({ args: ['split', '-a', '1', '-l', '4', '/in'], files: { '/in': lines } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: output file suffixes exhausted\n');
      expect(await readBack(h.fs as never, '/xa')).toBe('0\n1\n2\n3\n');
      expect(await readBack(h.fs as never, '/xz')).toBe('100\n101\n102\n103\n');
      expect(() => h.fs.stat('/x')).toThrow();
    });
    test('fixed -a 2 alpha exactly 676 pieces fits (no error)', async () => {
      const lines = Array.from({ length: 676 }, () => 'L').join('\n') + '\n';
      const h = makeIO({ args: ['split', '-a', '2', '-l', '1', '/in'], files: { '/in': lines } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xzz')).toBe('L\n');
    });
    test('auto width (no -a) never exhausts — it widens past the 2-digit span', async () => {
      const lines = Array.from({ length: 700 }, () => 'L').join('\n') + '\n';
      const h = makeIO({ args: ['split', '-l', '1', '/in'], files: { '/in': lines } });
      expect(await splitCommand(h.io)).toBe(0);
      expect(await readBack(h.fs as never, '/xzz')).toBe('L\n'); // index 675, last 2-digit name
      expect(await readBack(h.fs as never, `/x${suffixFor(699, 0, 'alpha')}`)).toBe('L\n');
    });
    test('numeric start value counts toward exhaustion', async () => {
      const lines = Array.from({ length: 10 }, () => 'L').join('\n') + '\n';
      const h = makeIO({ args: ['split', '--numeric-suffixes=95', '-a', '2', '-l', '1', '/in'], files: { '/in': lines } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: output file suffixes exhausted\n');
      expect(await readBack(h.fs as never, '/x95')).toBe('L\n');
      expect(await readBack(h.fs as never, '/x99')).toBe('L\n');
    });
  });

  // ── M7: unknown options are rejected (exit 1) ───────────────────────────────
  describe('unknown option rejection', () => {
    test('long unknown option → exit 1 + unrecognized diagnostic', async () => {
      const h = makeIO({ args: ['split', '--bogus', '/in'], files: { '/in': 'a\n' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: unrecognized option \'--bogus\'\nTry \'split --help\' for more information.\n');
    });
    test('short unknown option → exit 1 + invalid-option diagnostic', async () => {
      const h = makeIO({ args: ['split', '-Z', '/in'], files: { '/in': 'a\n' } });
      expect(await splitCommand(h.io)).toBe(1);
      expect(h.err()).toBe('split: invalid option -- \'Z\'\nTry \'split --help\' for more information.\n');
    });
  });
});
