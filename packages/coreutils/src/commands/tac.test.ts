import { expect, test, describe } from 'vitest';
import { tacCommand } from './tac.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: { args: string[]; stdinText?: string; files?: Record<string, string> }) {
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

describe('tac', () => {
  test('reverses lines from stdin', async () => {
    const h = makeIO({ args: ['tac'], stdinText: 'one\ntwo\nthree\n' });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('three\ntwo\none\n');
  });

  test('single line unchanged', async () => {
    const h = makeIO({ args: ['tac'], stdinText: 'hello\n' });
    await tacCommand(h.io);
    expect(h.out()).toBe('hello\n');
  });

  test('no trailing newline handled', async () => {
    const h = makeIO({ args: ['tac'], stdinText: 'a\nb' });
    await tacCommand(h.io);
    expect(h.out()).toBe('b\na\n');
  });

  test('reads from a file', async () => {
    const h = makeIO({
      args: ['tac', '/f.txt'],
      files: { '/f.txt': 'x\ny\nz\n' },
    });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('z\ny\nx\n');
  });

  test('missing file reports error, exits 1', async () => {
    const h = makeIO({ args: ['tac', '/missing.txt'] });
    const code = await tacCommand(h.io);
    expect(code).toBe(1);
    expect(h.err()).toContain('/missing.txt');
  });
});
