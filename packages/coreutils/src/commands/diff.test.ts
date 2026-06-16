import { expect, test, describe } from 'vitest';
import { diffCommand } from './diff.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; files?: Record<string, string> }) {
  const files = opts.files ?? {};
  const enc = new TextEncoder();
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
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

describe('diff', () => {
  test('identical files → exit 0, no output', async () => {
    const h = makeIO({
      args: ['diff', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\nbar\n', '/b.txt': 'foo\nbar\n' },
    });
    expect(await diffCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('different files → exit 1, normal diff output', async () => {
    const h = makeIO({
      args: ['diff', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\nbar\n', '/b.txt': 'foo\nbaz\n' },
    });
    const code = await diffCommand(h.io);
    expect(code).toBe(1);
    const out = h.out();
    expect(out).toContain('bar');
    expect(out).toContain('baz');
  });

  test('-u unified output', async () => {
    const h = makeIO({
      args: ['diff', '-u', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\nbar\n', '/b.txt': 'foo\nbaz\n' },
    });
    const code = await diffCommand(h.io);
    expect(code).toBe(1);
    expect(h.out()).toContain('---');
    expect(h.out()).toContain('+++');
    expect(h.out()).toContain('-bar');
    expect(h.out()).toContain('+baz');
  });

  test('-q brief output', async () => {
    const h = makeIO({
      args: ['diff', '-q', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\n', '/b.txt': 'bar\n' },
    });
    const code = await diffCommand(h.io);
    expect(code).toBe(1);
    expect(h.out()).toContain('differ');
  });

  test('-q identical files → exit 0, no output', async () => {
    const h = makeIO({
      args: ['diff', '-q', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'same\n', '/b.txt': 'same\n' },
    });
    expect(await diffCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file → exit 2', async () => {
    const h = makeIO({
      args: ['diff', '/missing.txt', '/b.txt'],
      files: { '/b.txt': 'b\n' },
    });
    expect(await diffCommand(h.io)).toBe(2);
    expect(h.err()).toContain('missing.txt');
  });

  test('missing operand → exit 2', async () => {
    const h = makeIO({ args: ['diff', '/only-one.txt'], files: { '/only-one.txt': 'x\n' } });
    expect(await diffCommand(h.io)).toBe(2);
  });
});
