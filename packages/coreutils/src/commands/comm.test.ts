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

  test('-1 suppresses col1', async () => {
    const h = makeIO({
      args: ['comm', '-1', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\nb\n', '/b.txt': 'b\nc\n' },
    });
    await commCommand(h.io);
    const out = h.out();
    expect(out).not.toContain('a\n');   // 'a' is col1 — suppressed
    expect(out).toContain('c');          // col2
    expect(out).toContain('b');          // col3
  });

  test('-12 only shows common lines', async () => {
    const h = makeIO({
      args: ['comm', '-12', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\nb\nc\n', '/b.txt': 'b\nc\nd\n' },
    });
    await commCommand(h.io);
    expect(h.out()).toBe('\t\tb\n\t\tc\n');
  });

  test('-3 hides common lines', async () => {
    const h = makeIO({
      args: ['comm', '-3', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\nb\n', '/b.txt': 'b\nc\n' },
    });
    await commCommand(h.io);
    const out = h.out();
    expect(out).not.toContain('b'); // col3 (common) suppressed
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  test('missing file exits 1', async () => {
    const h = makeIO({ args: ['comm', '/missing', '/b.txt'], files: { '/b.txt': 'x\n' } });
    expect(await commCommand(h.io)).toBe(1);
  });

  test('missing operand exits 1', async () => {
    const h = makeIO({ args: ['comm', '/only-one.txt'], files: { '/only-one.txt': 'x\n' } });
    expect(await commCommand(h.io)).toBe(1);
  });
});
