import { expect, test, describe } from 'vitest';
import { commCommand } from './comm.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; files?: Record<string, string>; stdinText?: string }) {
  const files = opts.files ?? {};
  const enc = new TextEncoder();
  const stdinBytes = enc.encode(opts.stdinText ?? '');
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(stdinBytes); c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const open = new Map<number, { bytes: Uint8Array; offset: number }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      if (!(path in files)) throw Object.assign(new Error('No such file or directory'), { errno: 'ENOENT' });
      const fd = nextFd++;
      open.set(fd, { bytes: enc.encode(files[path]), offset: 0 });
      return { fd };
    }
    if (call === 'fs/read') {
      const e = open.get(Number(args.fd))!;
      const len = Number(args.len ?? 0);
      const slice = e.bytes.subarray(e.offset, e.offset + len);
      e.offset += slice.byteLength;
      return slice;
    }
    if (call === 'fs/close') { open.delete(Number(args.fd)); return {}; }
    throw new Error(`unexpected syscall ${call}`);
  };
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('comm', () => {
  test('three columns for sorted files', async () => {
    const h = makeIO({
      args: ['comm', '/a.txt', '/b.txt'],
      files: {
        '/a.txt': 'apple\nbat\ncat\n',
        '/b.txt': 'bat\ncat\ndog\n',
      },
    });
    expect(await commCommand(h.io)).toBe(0);
    const out = h.out();
    // 'apple' only in file1 → column 1 (no indent)
    expect(out).toContain('apple\n');
    // 'dog' only in file2 → column 2 (one tab)
    expect(out).toContain('\tdog\n');
    // 'bat', 'cat' in both → column 3 (two tabs)
    expect(out).toContain('\t\tbat\n');
    expect(out).toContain('\t\tcat\n');
  });

  test('-1 suppresses col1: col2 unindented, col3 keeps one tab', async () => {
    const h = makeIO({
      args: ['comm', '-1', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\nb\n', '/b.txt': 'b\nc\n' },
    });
    await commCommand(h.io);
    // col3 (common 'b') is indented by one tab (col2 still shown); col2 ('c') has none.
    expect(h.out()).toBe('\tb\nc\n');
  });

  test('-12 shows common lines with NO indent (prefixes reduce)', async () => {
    const h = makeIO({
      args: ['comm', '-12', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\nb\nc\n', '/b.txt': 'b\nc\nd\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('b\nc\n');
  });

  test('-2 suppresses col2: col1 unindented, col3 keeps one tab', async () => {
    const h = makeIO({
      args: ['comm', '-2', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\n', '/b.txt': 'banana\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('apple\n\tbanana\n');
  });

  test('-3 hides common lines: col1 unindented, col2 one tab', async () => {
    const h = makeIO({
      args: ['comm', '-3', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\n', '/b.txt': 'banana\ndog\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('apple\n\tdog\n');
  });

  test('--output-delimiter replaces the tab prefixes', async () => {
    const h = makeIO({
      args: ['comm', '--output-delimiter=:', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\ncat\n', '/b.txt': 'banana\ncat\ndog\n' },
    });
    await commCommand(h.io);
    // col1 apple no prefix; col3 (banana,cat) double delim; col2 (dog) single delim.
    expect(h.out()).toBe('apple\n::banana\n::cat\n:dog\n');
  });

  test('--total appends a delimiter-separated count line', async () => {
    const h = makeIO({
      args: ['comm', '--total', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\ncat\n', '/b.txt': 'banana\ncat\ndog\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('apple\n\t\tbanana\n\t\tcat\n\tdog\n1\t1\t2\ttotal\n');
  });

  test('--total counts all columns even when suppressed', async () => {
    const h = makeIO({
      args: ['comm', '--total', '-12', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\ncat\n', '/b.txt': 'banana\ncat\ndog\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('banana\ncat\n1\t1\t2\ttotal\n');
  });

  test('--total honors --output-delimiter in the count line', async () => {
    const h = makeIO({
      args: ['comm', '--total', '--output-delimiter=:', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'apple\nbanana\ncat\n', '/b.txt': 'banana\ncat\ndog\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('apple\n::banana\n::cat\n:dog\n1:1:2:total\n');
  });

  test('invalid option exits 1', async () => {
    const h = makeIO({ args: ['comm', '-x', '/a.txt', '/b.txt'], files: { '/a.txt': 'a\n', '/b.txt': 'b\n' } });
    expect(await commCommand(h.io)).toBe(1);
    expect(h.err()).toContain('comm: invalid option -- \'x\'');
  });

  test('missing file exits 1', async () => {
    const h = makeIO({ args: ['comm', '/missing', '/b.txt'], files: { '/b.txt': 'x\n' } });
    expect(await commCommand(h.io)).toBe(1);
  });

  test('missing operand exits 1', async () => {
    const h = makeIO({ args: ['comm', '/only-one.txt'], files: { '/only-one.txt': 'x\n' } });
    expect(await commCommand(h.io)).toBe(1);
  });

  // ── input order checking (GNU parity) ─────────────────────────────────────
  test('default: unsorted input warns and exits 1 but still merges', async () => {
    const h = makeIO({ args: ['comm', '/a', '/b'], files: { '/a': 'c\na\n', '/b': 'a\nb\n' } });
    expect(await commCommand(h.io)).toBe(1);
    // Full merge is still emitted on stdout.
    expect(h.out()).toBe('\ta\n\tb\nc\na\n');
    expect(h.err()).toBe('comm: file 1 is not in sorted order\ncomm: input is not in sorted order\n');
  });

  test('--check-order aborts on the first disorder', async () => {
    const h = makeIO({ args: ['comm', '--check-order', '/a', '/b'], files: { '/a': 'a\nc\nb\n', '/b': 'a\nz\n' } });
    expect(await commCommand(h.io)).toBe(1);
    // Emits the common 'a' and the pairable 'c' before the fatal disorder read.
    expect(h.out()).toBe('\t\ta\nc\n');
    expect(h.err()).toBe('comm: file 1 is not in sorted order\n');
  });

  test('--check-order names the disordered file (file 2)', async () => {
    const h = makeIO({ args: ['comm', '--check-order', '/a', '/b'], files: { '/a': 'a\nb\n', '/b': 'z\nx\n' } });
    expect(await commCommand(h.io)).toBe(1);
    expect(h.err()).toBe('comm: file 2 is not in sorted order\n');
  });

  test('--nocheck-order stays silent on unsorted input and exits 0', async () => {
    const h = makeIO({ args: ['comm', '--nocheck-order', '/a', '/b'], files: { '/a': 'c\na\n', '/b': 'z\nx\n' } });
    expect(await commCommand(h.io)).toBe(0);
    expect(h.err()).toBe('');
  });

  test('sorted input: no diagnostic, exit 0', async () => {
    const h = makeIO({ args: ['comm', '/a', '/b'], files: { '/a': 'a\nb\n', '/b': 'b\nc\n' } });
    expect(await commCommand(h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toBe('a\n\t\tb\n\tc\n');
  });

  test('--total still prints the count line on disordered input', async () => {
    const h = makeIO({ args: ['comm', '--total', '/a', '/b'], files: { '/a': 'c\na\n', '/b': 'a\nb\n' } });
    expect(await commCommand(h.io)).toBe(1);
    expect(h.out()).toBe('\ta\n\tb\nc\na\n2\t2\t0\ttotal\n');
  });

  // ── -z / --zero-terminated (NUL records) ──────────────────────────────────
  test('-z splits input on NUL and terminates records with NUL', async () => {
    const h = makeIO({ args: ['comm', '-z', '/a', '/b'], files: { '/a': 'a\0b\0', '/b': 'b\0c\0' } });
    expect(await commCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\0\t\tb\0\tc\0');
  });

  test('-z --total: count line is NUL-terminated', async () => {
    const h = makeIO({ args: ['comm', '-z', '--total', '/a', '/b'], files: { '/a': 'a\0b\0', '/b': 'b\0c\0' } });
    expect(await commCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\0\t\tb\0\tc\0' + '1\t1\t1\ttotal\0');
  });
});
