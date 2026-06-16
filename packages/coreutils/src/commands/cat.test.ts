import { expect, test, describe } from 'vitest';
import { catCommand } from './cat.ts';
import type { CommandIO } from '../harness.ts';

// In-memory CommandIO builder: a fake VFS for fs/* syscalls, capturing streams.
function makeIO(opts: {
  args: string[];
  stdinText?: string;
  files?: Record<string, string>;
}): { io: CommandIO; out(): string; err(): string } {
  const files = opts.files ?? {};
  const enc = new TextEncoder();

  const stdin = new ReadableStream<Uint8Array>({
    start(c) { if (opts.stdinText) c.enqueue(enc.encode(opts.stdinText)); c.close(); },
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });

  // Minimal fs/* fake: open returns a fd bound to file bytes; read drains it.
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
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  };

  return {
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall },
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('cat', () => {
  test('reads stdin when no operands', async () => {
    const h = makeIO({ args: ['cat'], stdinText: 'from stdin\n' });
    const code = await catCommand(h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe('from stdin\n');
  });

  test('"-" operand reads stdin', async () => {
    const h = makeIO({ args: ['cat', '-'], stdinText: 'dash stdin' });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('dash stdin');
  });

  test('reads a single file', async () => {
    const h = makeIO({ args: ['cat', '/a.txt'], files: { '/a.txt': 'hello\n' } });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
  });

  test('concatenates multiple files in order', async () => {
    const h = makeIO({
      args: ['cat', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'A\n', '/b.txt': 'B\n' },
    });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('A\nB\n');
  });

  test('-n numbers lines across the whole output', async () => {
    const h = makeIO({
      args: ['cat', '-n', '/a.txt'],
      files: { '/a.txt': 'one\ntwo\n' },
    });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tone\n     2\ttwo\n');
  });

  test('--number is an alias for -n', async () => {
    const h = makeIO({ args: ['cat', '--number', '/a.txt'], files: { '/a.txt': 'x\n' } });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\tx\n');
  });

  test('-n continues numbering across multiple files', async () => {
    const h = makeIO({
      args: ['cat', '-n', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'a\n', '/b.txt': 'b\n' },
    });
    expect(await catCommand(h.io)).toBe(0);
    expect(h.out()).toBe('     1\ta\n     2\tb\n');
  });

  test('missing file reports error to stderr, exits 1, continues other files', async () => {
    const h = makeIO({
      args: ['cat', '/missing', '/b.txt'],
      files: { '/b.txt': 'B\n' },
    });
    const code = await catCommand(h.io);
    expect(code).toBe(1);
    expect(h.out()).toBe('B\n');
    expect(h.err()).toContain('cat: /missing:');
  });
});
