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
  isatty?: (fd: number) => boolean;
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
    io: { args: opts.args, env: {}, cwd: '/', stdin, stdout, stderr, syscall, isatty: opts.isatty },
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

  test('--color=always wraps matches in SGR with GNU \\e[K', async () => {
    const h = makeIO({ args: ['grep', '--color=always', 'b'], stdinText: 'abc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    // GNU emits `\e[01;31m\e[K` before and `\e[m\e[K` after each match.
    expect(h.out()).toBe('a\x1b[01;31m\x1b[Kb\x1b[m\x1b[Kc\n');
  });

  test('--color=always colors -o matches only', async () => {
    const h = makeIO({ args: ['grep', '--color=always', '-o', 'foo'], stdinText: 'xfooxfoo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\x1b[01;31m\x1b[Kfoo\x1b[m\x1b[K\n\x1b[01;31m\x1b[Kfoo\x1b[m\x1b[K\n');
  });

  test('--color=always colors filename/line-number/separator fields', async () => {
    const h = makeIO({ args: ['grep', '--color=always', '-Hn', 'foo', '/a.txt'], files: { '/a.txt': 'abc\nfoobar\n' } });
    expect(await grepCommand(h.io)).toBe(0);
    // magenta filename (35), cyan `:` (36), green line number (32), red match.
    expect(h.out()).toBe(
      '\x1b[35m\x1b[K/a.txt\x1b[m\x1b[K\x1b[36m\x1b[K:\x1b[m\x1b[K'
      + '\x1b[32m\x1b[K2\x1b[m\x1b[K\x1b[36m\x1b[K:\x1b[m\x1b[K'
      + '\x1b[01;31m\x1b[Kfoo\x1b[m\x1b[Kbar\n',
    );
  });

  test('--color=always does NOT wrap zero-length matches (o* only colors the oo run)', async () => {
    const h = makeIO({ args: ['grep', '--color=always', 'o*'], stdinText: 'foo bar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    // GNU highlights only the non-empty `oo` run — no empty colored region at
    // every character boundary.
    expect(h.out()).toBe('f\x1b[01;31m\x1b[Koo\x1b[m\x1b[K bar\n');
  });

  test('--color=always with anchor-only pattern ^ emits no SGR (zero-length match)', async () => {
    const h = makeIO({ args: ['grep', '--color=always', '^'], stdinText: 'hello\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
  });

  test('--color=always with $ anchor emits no SGR (zero-length match)', async () => {
    const h = makeIO({ args: ['grep', '--color=always', '$'], stdinText: 'hello\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
  });

  test('--color=auto emits NO color when stdout is not a TTY', async () => {
    const h = makeIO({ args: ['grep', '--color=auto', 'foo'], stdinText: 'foo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\n');
  });

  test('--color=auto emits SGR when stdout IS a TTY', async () => {
    const h = makeIO({ args: ['grep', '--color=auto', 'b'], stdinText: 'abc\n', isatty: (fd) => fd === 1 });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\x1b[01;31m\x1b[Kb\x1b[m\x1b[Kc\n');
  });

  test('bare --color emits NO color when stdout is not a TTY', async () => {
    const h = makeIO({ args: ['grep', '--color', 'foo'], stdinText: 'foo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\n');
  });

  test('--color=always still emits SGR regardless of TTY', async () => {
    const h = makeIO({ args: ['grep', '--color=always', 'b'], stdinText: 'abc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\x1b[01;31m\x1b[Kb\x1b[m\x1b[Kc\n');
  });

  test('-P accepts leading (?i) inline-flag prefix', async () => {
    const h = makeIO({ args: ['grep', '-P', '(?i)FOO'], stdinText: 'foo\nFOO\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nFOO\n');
  });

  test('-P accepts leading (?-i) inline-flag prefix', async () => {
    const h = makeIO({ args: ['grep', '-P', '(?-i)foo'], stdinText: 'foo\nFOO\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\n');
  });

  test('-P still accepts the (?i:...) group form', async () => {
    const h = makeIO({ args: ['grep', '-P', '(?i:FOO)'], stdinText: 'foo\nFOO\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nFOO\n');
  });

  test('-P leading (?ms) multi-flag prefix', async () => {
    const h = makeIO({ args: ['grep', '-P', '(?is)F.O'], stdinText: 'fxo\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('fxo\n');
  });

  test('--color=always [0-9]* only colors the digit run', async () => {
    const h = makeIO({ args: ['grep', '--color=always', '-E', '[0-9]*'], stdinText: 'abc123def\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\x1b[01;31m\x1b[K123\x1b[m\x1b[Kdef\n');
  });

  // ── word-boundary / leading-orphan / -P / -H / -h / -b / -z ────────────────

  test('\\< \\> word-boundary anchors match whole words', async () => {
    const h = makeIO({ args: ['grep', '\\<bar\\>'], stdinText: 'foo bar\nbarfoo\nfoobar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo bar\n');
  });

  test('\\< with -o extracts the word start', async () => {
    const h = makeIO({ args: ['grep', '-o', '\\<foo'], stdinText: 'foo barfoo\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\n');
  });

  test('leading orphan * in BRE is a literal, not an error', async () => {
    const h = makeIO({ args: ['grep', '*star'], stdinText: '*star\nplain\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('*star\n');
  });

  test('leading orphan * in ERE is a no-op (matches as if absent)', async () => {
    const h = makeIO({ args: ['grep', '-E', '*x'], stdinText: '*x\nax\ny\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('*x\nax\n');
  });

  test('-o suppresses spurious empty-match blank lines', async () => {
    const h = makeIO({ args: ['grep', '-o', 'a*'], stdinText: 'aaabaaa\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aaa\naaa\n');
  });

  test('-o with an all-empty match matches the line but prints nothing (exit 0)', async () => {
    const h = makeIO({ args: ['grep', '-o', 'x*'], stdinText: 'abc\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-P PCRE lookahead', async () => {
    const h = makeIO({ args: ['grep', '-P', 'foo(?=bar)'], stdinText: 'foobar\nfoobaz\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foobar\n');
  });

  test('-P PCRE lookbehind', async () => {
    const h = makeIO({ args: ['grep', '-oP', '(?<=foo)bar'], stdinText: 'foobar\nxxbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar\n');
  });

  test('-H forces the filename prefix on a single file', async () => {
    const h = makeIO({ args: ['grep', '-H', 'bar', '/a.txt'], files: { '/a.txt': 'foo bar\nbarfoo\n' } });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a.txt:foo bar\n/a.txt:barfoo\n');
  });

  test('-h suppresses the filename prefix even with multiple files', async () => {
    const h = makeIO({
      args: ['grep', '-h', 'bar', '/a.txt', '/b.txt'],
      files: { '/a.txt': 'foo bar\n', '/b.txt': 'zzbar\n' },
    });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo bar\nzzbar\n');
  });

  test('-b prints the byte offset of each matching line', async () => {
    const h = makeIO({ args: ['grep', '-b', 'bar', '/a.txt'], files: { '/a.txt': 'foo bar\nbarfoo\n' } });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0:foo bar\n8:barfoo\n');
  });

  test('-b with -o prints the byte offset of each match', async () => {
    const h = makeIO({ args: ['grep', '-bo', 'bar'], stdinText: 'xxbarxxbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2:bar\n7:bar\n');
  });

  test('-b with -n prints byteoffset then line number', async () => {
    const h = makeIO({ args: ['grep', '-bn', 'bar'], stdinText: 'a\nbar\n' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2:2:bar\n');
  });

  test('-z NUL-separated records, NUL-terminated output', async () => {
    const h = makeIO({ args: ['grep', '-z', 'foo'], stdinText: 'foo\0bar\0foobar\0' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\0foobar\0');
  });

  test('-z record may contain newlines', async () => {
    const h = makeIO({ args: ['grep', '-z', 'x'], stdinText: 'a\nx\0b\ny\0' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nx\0');
  });

  test('-c with -z still terminates the count with a newline', async () => {
    const h = makeIO({ args: ['grep', '-cz', 'x'], stdinText: 'x\0y\0x\0' });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n');
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

  // C3: GNU `-q` precedence — error(2) > no-match(1), but a match(0) wins over error.
  test('-q returns 2 on a read error (missing file), no output', async () => {
    const h = makeIO({ args: ['grep', '-q', 'x', '/nonexistent'] });
    expect(await grepCommand(h.io)).toBe(2);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('');
  });

  test('-q returns 0 when a match is found before an unreadable file', async () => {
    const h = makeIO({ args: ['grep', '-q', 'hit', '/a', '/nonexistent'], files: { '/a': 'hit\n' } });
    expect(await grepCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('-q returns 2 when a read error occurs without any match', async () => {
    const h = makeIO({ args: ['grep', '-q', 'zzz', '/a', '/nonexistent'], files: { '/a': 'foo\n' } });
    expect(await grepCommand(h.io)).toBe(2);
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
