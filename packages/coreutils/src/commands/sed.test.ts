import { expect, test, describe } from 'vitest';
import { sedCommand } from './sed.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(opts: {
  args: string[];
  stdinText?: string;
  files?: Record<string, string>;
}): { io: CommandIO; out(): string; err(): string; files: Record<string, string> } {
  const files = { ...(opts.files ?? {}) };
  const enc = new TextEncoder();

  const stdin = new ReadableStream<Uint8Array>({
    start(c) { if (opts.stdinText !== undefined) c.enqueue(enc.encode(opts.stdinText)); c.close(); },
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });

  const open = new Map<number, { path: string; bytes: Uint8Array; offset: number; write: boolean }>();
  let nextFd = 3;
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'fs/open') {
      const path = String(args.path);
      const oflags = (args.oflags ?? {}) as { write?: boolean; create?: boolean; truncate?: boolean };
      const write = Boolean(oflags.write || oflags.create || oflags.truncate);
      if (!write && !(path in files)) throw Object.assign(new Error('No such file or directory'), { errno: 'ENOENT' });
      const fd = nextFd++;
      if (write && oflags.truncate) files[path] = '';
      open.set(fd, { path, bytes: enc.encode(files[path] ?? ''), offset: 0, write });
      return { fd };
    }
    if (call === 'fs/read') {
      const e = open.get(Number(args.fd))!;
      const len = Number(args.len ?? 0);
      const slice = e.bytes.subarray(e.offset, e.offset + len);
      e.offset += slice.byteLength;
      return slice;
    }
    if (call === 'fs/write') {
      const e = open.get(Number(args.fd))!;
      const data = args.data as Uint8Array;
      files[e.path] = (files[e.path] ?? '') + new TextDecoder().decode(data);
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
    files,
  };
}

describe('sed s///', () => {
  test('simple substitution (first occurrence)', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/'], stdinText: 'aaa\nbab\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Xaa\nbXb\n');
  });

  test('global flag', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/g'], stdinText: 'aaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XXX\n');
  });

  test('ignore-case flag', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/gi'], stdinText: 'aAa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XXX\n');
  });

  test('& inserts whole match', async () => {
    const h = makeIO({ args: ['sed', 's/ell/[&]/'], stdinText: 'hello\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('h[ell]o\n');
  });

  test('backreferences \\1', async () => {
    const h = makeIO({ args: ['sed', '-E', 's/(a)(b)/\\2\\1/'], stdinText: 'ab\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ba\n');
  });

  test('Nth occurrence flag', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/2'], stdinText: 'aaaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aXaa\n');
  });

  test('Ng replaces from Nth onward', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/2g'], stdinText: 'aaaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aXXX\n');
  });

  test('s///p with -n prints only changed lines', async () => {
    const h = makeIO({ args: ['sed', '-n', 's/foo/bar/p'], stdinText: 'foo\nbaz\nfoo\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar\nbar\n');
  });

  test('alternate delimiter s|a|b|', async () => {
    const h = makeIO({ args: ['sed', 's|/usr|/opt|'], stdinText: '/usr/bin\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/opt/bin\n');
  });

  test('replacement \\n produces newline', async () => {
    const h = makeIO({ args: ['sed', 's/,/\\n/g'], stdinText: 'a,b,c\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });
});

describe('sed addresses', () => {
  test('line address N', async () => {
    const h = makeIO({ args: ['sed', '2s/./X/'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nX\nc\n');
  });

  test('last line $', async () => {
    const h = makeIO({ args: ['sed', '$s/./X/'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nX\n');
  });

  test('regex address /re/', async () => {
    const h = makeIO({ args: ['sed', '/foo/s/o/0/g'], stdinText: 'foo\nbar\nfoobar\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('f00\nbar\nf00bar\n');
  });

  test('line range N,M', async () => {
    const h = makeIO({ args: ['sed', '2,3d'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nd\n');
  });

  test('regex range /re1/,/re2/', async () => {
    const h = makeIO({ args: ['sed', '/start/,/end/d'], stdinText: 'a\nstart\nb\nend\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\n');
  });
});

describe('sed commands', () => {
  test('d delete by pattern', async () => {
    const h = makeIO({ args: ['sed', '/two/d'], stdinText: 'one\ntwo\nthree\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('one\nthree\n');
  });

  test('p with -n prints addressed lines', async () => {
    const h = makeIO({ args: ['sed', '-n', '2p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('q quits after line', async () => {
    const h = makeIO({ args: ['sed', '2q'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('= prints line numbers', async () => {
    const h = makeIO({ args: ['sed', '-n', '='], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n');
  });

  test('y transliterate', async () => {
    const h = makeIO({ args: ['sed', 'y/abc/xyz/'], stdinText: 'cab\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('zxy\n');
  });

  test('a append text', async () => {
    const h = makeIO({ args: ['sed', '1a hello'], stdinText: 'x\ny\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nhello\ny\n');
  });

  test('i insert text', async () => {
    const h = makeIO({ args: ['sed', '2i hello'], stdinText: 'x\ny\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nhello\ny\n');
  });

  test('c change line', async () => {
    const h = makeIO({ args: ['sed', '2c CHANGED'], stdinText: 'x\ny\nz\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nCHANGED\nz\n');
  });
});

describe('sed flags & files', () => {
  test('multiple -e expressions', async () => {
    const h = makeIO({ args: ['sed', '-e', 's/a/X/', '-e', 's/b/Y/'], stdinText: 'ab\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XY\n');
  });

  test('semicolon-separated commands', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/;s/b/Y/'], stdinText: 'ab\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('XY\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['sed', 's/o/0/g', '/f.txt'], files: { '/f.txt': 'foo\n' } });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('f00\n');
  });

  test('-i writes back to the file', async () => {
    const h = makeIO({ args: ['sed', '-i', 's/o/0/g', '/f.txt'], files: { '/f.txt': 'foo\nbox\n' } });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.files['/f.txt']).toBe('f00\nb0x\n');
  });

  test('missing file → exit 2', async () => {
    const h = makeIO({ args: ['sed', 's/a/b/', '/nope'], files: {} });
    expect(await sedCommand(h.io)).toBe(2);
    expect(h.err()).toContain('/nope');
  });

  test('no trailing newline is preserved', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/'], stdinText: 'aaa' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Xaa');
  });
});
