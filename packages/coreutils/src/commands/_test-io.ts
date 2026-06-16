/**
 * Shared in-memory {@link CommandIO} builder for command unit tests.
 *
 * Provides a fake VFS over `fs/open`/`fs/read`/`fs/write`/`fs/close` and captures
 * stdout/stderr. `files` seeds readable content; written files are recorded and
 * exposed via `file(path)` so write-side commands (e.g. `tee`) can be asserted.
 */
import type { CommandIO } from '../harness.ts';

export interface TestHarness {
  io: CommandIO;
  out(): string;
  err(): string;
  file(path: string): string | undefined;
}

interface OpenEntry { path: string; bytes: Uint8Array; offset: number; write: boolean; append: boolean; }

export function makeIO(opts: {
  args: string[];
  stdinText?: string;
  files?: Record<string, string>;
}): TestHarness {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(opts.files ?? {})) files.set(p, enc.encode(c));

  const stdin = new ReadableStream<Uint8Array>({
    start(c) { if (opts.stdinText) c.enqueue(enc.encode(opts.stdinText)); c.close(); },
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c.slice()); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c.slice()); } });

  const open = new Map<number, OpenEntry>();
  let nextFd = 3;

  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      const oflags = (args.oflags ?? {}) as Record<string, boolean>;
      const write = Boolean(oflags.write || oflags.create || oflags.truncate || oflags.append);
      if (!write && !files.has(path)) {
        throw Object.assign(new Error('No such file or directory'), { errno: 'ENOENT' });
      }
      let bytes = files.get(path) ?? new Uint8Array();
      if (oflags.truncate) bytes = new Uint8Array();
      const fd = nextFd++;
      open.set(fd, { path, bytes, offset: oflags.append ? bytes.byteLength : 0, write, append: Boolean(oflags.append) });
      return { fd };
    }
    if (call === 'fs/read') {
      const e = open.get(Number(args.fd))!;
      const len = Number(args.len ?? 0);
      const slice = e.bytes.subarray(e.offset, e.offset + len);
      e.offset += slice.byteLength;
      return slice.slice();
    }
    if (call === 'fs/write') {
      const e = open.get(Number(args.fd))!;
      const data = args.data as Uint8Array;
      const offset = typeof args.offset === 'number' ? args.offset : e.offset;
      const end = offset + data.byteLength;
      const next = new Uint8Array(Math.max(e.bytes.byteLength, end));
      next.set(e.bytes, 0);
      next.set(data, offset);
      e.bytes = next;
      if (typeof args.offset !== 'number') e.offset = end;
      files.set(e.path, e.bytes);
      return { written: data.byteLength };
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
    file: (path: string) => { const b = files.get(path); return b ? new TextDecoder().decode(b) : undefined; },
  };
}
