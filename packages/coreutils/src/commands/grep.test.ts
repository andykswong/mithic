import { expect, test, describe } from 'vitest';
import { grepCommand } from './grep.ts';
import type { CommandIO } from '../harness.ts';

interface Tree { [path: string]: string }

// In-memory CommandIO with fs/open|read|close|stat|readdir over a flat path map.
// Directories are inferred from path prefixes.
function makeIO(opts: {
  args: string[];
  stdinText?: string;
  files?: Tree;
}): { io: CommandIO; out(): string; err(): string } {
  const files = opts.files ?? {};
  const enc = new TextEncoder();

  const stdin = new ReadableStream<Uint8Array>({
    start(c) { if (opts.stdinText !== undefined) c.enqueue(enc.encode(opts.stdinText)); c.close(); },
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });

  const dirChildren = (dir: string): { name: string; type: 'file' | 'directory' }[] => {
    const base = dir === '/' ? '/' : dir.replace(/\/+$/, '') + '/';
    const seen = new Map<string, 'file' | 'directory'>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(base)) continue;
      const rest = p.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) seen.set(rest.slice(0, slash), 'directory');
      else if (rest.length > 0) seen.set(rest, 'file');
    }
    return [...seen].map(([name, type]) => ({ name, type }));
  };
  const isDir = (path: string): boolean => {
    const base = path.replace(/\/+$/, '') + '/';
    return path === '/' || Object.keys(files).some((p) => p.startsWith(base));
  };

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
    if (call === 'fs/stat') {
      const path = String(args.path);
      if (path in files) return { type: 'file', size: 0n };
      if (isDir(path)) return { type: 'directory', size: 0n };
      throw Object.assign(new Error('No such file or directory'), { errno: 'ENOENT' });
    }
    if (call === 'fs/readdir') return dirChildren(String(args.path));
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

describe('grep', () => {
  test('basic match from stdin', async () => {
    const h = makeIO({ args: ['grep', 'foo'], stdinText: 'foo\nbar\nfoobar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nfoobar\n');
  });

  test('no match returns exit 1', async () => {
    const h = makeIO({ args: ['grep', 'zzz'], stdinText: 'foo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('POSIX class [[:digit:]] matches', async () => {
    const h = makeIO({ args: ['grep', '[[:digit:]]'], stdinText: 'a1\nbcd\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a1\n');
  });

  test('POSIX class [[:alpha:]] in ERE', async () => {
    const h = makeIO({ args: ['grep', '-E', '^[[:alpha:]]+$'], stdinText: 'abc\na1c\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\n');
  });

  test('-i ignore case', async () => {
    const h = makeIO({ args: ['grep', '-i', 'FOO'], stdinText: 'Foo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Foo\n');
  });

  test('-v invert', async () => {
    const h = makeIO({ args: ['grep', '-v', 'foo'], stdinText: 'foo\nbar\nbaz\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar\nbaz\n');
  });

  test('-n line numbers', async () => {
    const h = makeIO({ args: ['grep', '-n', 'b'], stdinText: 'a\nb\nc\nb\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2:b\n4:b\n');
  });

  test('-c count', async () => {
    const h = makeIO({ args: ['grep', '-c', 'a'], stdinText: 'a\nab\nc\na\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('-o only matching', async () => {
    const h = makeIO({ args: ['grep', '-o', '-E', 'a+'], stdinText: 'xaaxax\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aa\na\n');
  });

  test('-w word match', async () => {
    const h = makeIO({ args: ['grep', '-w', 'cat'], stdinText: 'cat\ncatalog\nthe cat sat\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cat\nthe cat sat\n');
  });

  test('-x line match', async () => {
    const h = makeIO({ args: ['grep', '-x', 'foo'], stdinText: 'foo\nfoobar\nfoo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nfoo\n');
  });

  test('-E extended regex alternation', async () => {
    const h = makeIO({ args: ['grep', '-E', 'foo|baz'], stdinText: 'foo\nbar\nbaz\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nbaz\n');
  });

  test('-F fixed strings (metachars literal)', async () => {
    const h = makeIO({ args: ['grep', '-F', 'a.c'], stdinText: 'a.c\nabc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a.c\n');
  });

  test('BRE: bare + is literal; \\+ is one-or-more', async () => {
    const lit = makeIO({ args: ['grep', 'a+'], stdinText: 'a+\naaa\n' });
    expect(await grepCommand(lit.io)).toBe(0);
    expect(lit.out()).toBe('a+\n');

    const meta = makeIO({ args: ['grep', 'a\\+'], stdinText: 'a+\naaa\n' });
    expect(await grepCommand(meta.io)).toBe(0);
    expect(meta.out()).toBe('a+\naaa\n');
  });

  test('multiple -e patterns', async () => {
    const h = makeIO({ args: ['grep', '-e', 'foo', '-e', 'baz'], stdinText: 'foo\nbar\nbaz\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nbaz\n');
  });

  test('reads from a file', async () => {
    const h = makeIO({ args: ['grep', 'x', '/a.txt'], files: { '/a.txt': 'x\ny\nx\n' } });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nx\n');
  });

  test('multiple files prefix with name:', async () => {
    const h = makeIO({
      args: ['grep', 'm', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'match\nno\n', '/b.txt': 'mmm\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a.txt:match\n/b.txt:mmm\n');
  });

  test('-l files with matches', async () => {
    const h = makeIO({
      args: ['grep', '-l', 'foo', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\n', '/b.txt': 'bar\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a.txt\n');
  });

  test('-L files without matches', async () => {
    const h = makeIO({
      args: ['grep', '-L', 'foo', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo\n', '/b.txt': 'bar\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/b.txt\n');
  });

  test('missing file reports error and exit 2', async () => {
    const h = makeIO({ args: ['grep', 'x', '/missing'], files: {} });
    expect(await grepCommand(h.io)).toBe(2);
    expect(h.err()).toContain('/missing');
  });

  test('-A after context', async () => {
    const h = makeIO({ args: ['grep', '-A', '1', 'b'], stdinText: 'a\nb\nc\nd\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nc\n');
  });

  test('-B before context', async () => {
    const h = makeIO({ args: ['grep', '-B', '1', 'c'], stdinText: 'a\nb\nc\nd\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nc\n');
  });

  test('-C context with separator between groups', async () => {
    const h = makeIO({ args: ['grep', '-C', '1', 'match'], stdinText: 'x\nmatch\ny\nz\nz\nmatch\nw\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nmatch\ny\n--\nz\nmatch\nw\n');
  });

  test('-r recursive over directory, sorted', async () => {
    const h = makeIO({
      args: ['grep', '-r', 'hit', '/d'],
      files: { '/d/b.txt': 'hit\n', '/d/a.txt': 'miss\n', '/d/sub/c.txt': 'hit\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/d/b.txt:hit\n/d/sub/c.txt:hit\n');
  });

  test('missing pattern → exit 2', async () => {
    const h = makeIO({ args: ['grep'], stdinText: 'x\n' });
    expect(await grepCommand(h.io)).toBe(2);
    expect(h.err()).toContain('Usage');
  });

  test('egrep behaves as grep -E (via argv[0])', async () => {
    // In ERE `(ab)+` is a repeated group; in BRE the parens/+ are literal.
    const h = makeIO({ args: ['egrep', '(ab)+c'], stdinText: 'ababc\n(ab)+c\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ababc\n');
  });

  test('fgrep behaves as grep -F (via argv[0])', async () => {
    const h = makeIO({ args: ['fgrep', 'a.c'], stdinText: 'a.c\nabc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a.c\n');
  });

  test('--color=always wraps matches in SGR', async () => {
    const h = makeIO({ args: ['grep', '--color=always', 'b'], stdinText: 'abc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\x1b[01;31mb\x1b[0mc\n');
  });

  // ── B2.1: -q / -m / --include / --exclude ─────────────────────────────────

  test('-q suppresses output, exit 0 on a match', async () => {
    const h = makeIO({ args: ['grep', '-q', 'foo'], stdinText: 'foo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-q exit 1 with no output when nothing matches', async () => {
    const h = makeIO({ args: ['grep', '-q', 'zzz'], stdinText: 'foo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('--quiet long form behaves like -q', async () => {
    const h = makeIO({ args: ['grep', '--quiet', 'foo'], stdinText: 'foo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-m 2 stops after 2 matches', async () => {
    const h = makeIO({ args: ['grep', '-m', '2', 'a'], stdinText: 'a\na\na\na\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\na\n');
  });

  test('-m is per-file', async () => {
    const h = makeIO({
      args: ['grep', '-m', '1', 'x', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'x\nx\n', '/b.txt': 'x\nx\n' },
    });
    await grepCommand(h.io);
    expect(h.out()).toBe('/a.txt:x\n/b.txt:x\n');
  });

  test('-r --include filters to matching filenames', async () => {
    const h = makeIO({
      args: ['grep', '-r', '--include=*.txt', 'hit', '/d'],
      files: { '/d/a.txt': 'hit\n', '/d/b.log': 'hit\n', '/d/sub/c.txt': 'hit\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/d/a.txt:hit\n/d/sub/c.txt:hit\n');
  });

  test('-r --exclude skips matching filenames', async () => {
    const h = makeIO({
      args: ['grep', '-r', '--exclude=*.log', 'hit', '/d'],
      files: { '/d/a.txt': 'hit\n', '/d/b.log': 'hit\n' },
    });
    await grepCommand(h.io);
    expect(h.out()).toBe('/d/a.txt:hit\n');
  });
});
