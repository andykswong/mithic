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

describe('sed brace groups', () => {
  test('address-gated block runs only inside range', async () => {
    const h = makeIO({ args: ['sed', '-n', '2,3{p}'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nc\n');
  });

  test('multiple commands in a block', async () => {
    const h = makeIO({ args: ['sed', '-n', '/foo/{s/o/0/g;p}'], stdinText: 'foo\nbar\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('f00\n');
  });

  test('block skipped when address does not match', async () => {
    const h = makeIO({ args: ['sed', '/zzz/{s/a/X/}'], stdinText: 'aaa\nbbb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aaa\nbbb\n');
  });

  test('nested blocks', async () => {
    const h = makeIO({ args: ['sed', '-n', '1,3{/b/{p}}'], stdinText: 'a\nb\nbc\nbd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nbc\n');
  });

  test('block with newline-separated commands', async () => {
    const h = makeIO({ args: ['sed', '-n', '1{\np\n}'], stdinText: 'x\ny\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });
});

describe('sed hold space', () => {
  test('h then g copies via hold', async () => {
    const h = makeIO({ args: ['sed', '-n', '1h;2{g;p}'], stdinText: 'first\nsecond\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('first\n');
  });

  test('x exchanges pattern and hold', async () => {
    // Line1: x swaps empty hold in, hold=line1. Line2: x swaps line1 in.
    const h = makeIO({ args: ['sed', 'x'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\na\n');
  });

  test('H appends to hold with newline; G appends hold to pattern', async () => {
    const h = makeIO({ args: ['sed', '-n', '1!H;$!d;x;s/\\n/,/g;p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    // hold collects "\nb\nc" (line1 not H'd), x brings it to pattern; commas join.
    expect(h.out()).toBe(',b,c\n');
  });

  test('tac via sed: 1!G;h;$!d reverses lines', async () => {
    const h = makeIO({ args: ['sed', '1!G;h;$!d'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nb\na\n');
  });
});

describe('sed branching', () => {
  test('b to label skips intervening commands', async () => {
    const h = makeIO({ args: ['sed', 'bskip;s/a/X/;:skip'], stdinText: 'aaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aaa\n');
  });

  test('b with no label ends the script (skips later cmds)', async () => {
    const h = makeIO({ args: ['sed', '/foo/b;s/./X/'], stdinText: 'foo\nbar\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo\nXar\n');
  });

  test('t branches only after a successful s///', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/;ttaken;s/b/Y/;:taken'], stdinText: 'ab\ncb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    // line1: a→X succeeds, t taken, b not changed. line2: no a, b→Y.
    expect(h.out()).toBe('Xb\ncY\n');
  });

  test('T branches when NO s/// succeeded', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/;Tnone;s/$/!/;:none'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    // line1: a→X succeeds, T not taken, append !. line2: no a, T taken, skip.
    expect(h.out()).toBe('X!\nb\n');
  });

  test('loop with t: collapse runs of spaces to one', async () => {
    const h = makeIO({ args: ['sed', ':a;s/  / /;ta'], stdinText: 'x      y\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x y\n');
  });
});

describe('sed N/D/P multiline', () => {
  test('N joins next line into pattern space', async () => {
    const h = makeIO({ args: ['sed', 'N;s/\\n/ /'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a b\nc d\n');
  });

  test('P prints first line of pattern space', async () => {
    const h = makeIO({ args: ['sed', '-n', 'N;P'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\n');
  });

  test('N;P;D sliding window (join pairs idiom retains all lines)', async () => {
    // The classic "$!N;/\n/P;D" style: P prints first, D deletes & restarts.
    const h = makeIO({ args: ['sed', 'N;P;D'], stdinText: '1\n2\n3\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });

  test('D restarts cycle: squeeze blank lines (cat -s idiom)', async () => {
    // Canonical GNU idiom combining brace group + N + D.
    const h = makeIO({ args: ['sed', '/^$/{N;/^\\n$/D}'], stdinText: 'a\n\n\n\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\n\nb\n');
  });
});

describe('sed step & relative addresses', () => {
  test('1~2 matches odd lines', async () => {
    const h = makeIO({ args: ['sed', '-n', '1~2p'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\ne\n');
  });

  test('0~3 matches every third line', async () => {
    const h = makeIO({ args: ['sed', '-n', '0~3p'], stdinText: 'a\nb\nc\nd\ne\nf\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nf\n');
  });

  test('addr,+N selects N lines after the match', async () => {
    const h = makeIO({ args: ['sed', '-n', '/b/,+1p'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nc\n');
  });

  test('addr,~N runs until line multiple of N', async () => {
    const h = makeIO({ args: ['sed', '-n', '2,~3p'], stdinText: 'a\nb\nc\nd\ne\n' });
    expect(await sedCommand(h.io)).toBe(0);
    // starts at 2, ends at next multiple of 3 = line 3.
    expect(h.out()).toBe('b\nc\n');
  });
});

describe('sed c on a range emits once', () => {
  test('c over a range emits change text once at range end', async () => {
    const h = makeIO({ args: ['sed', '2,3c CHANGED'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nCHANGED\nd\n');
  });

  test('c on a single line still emits per matching line', async () => {
    const h = makeIO({ args: ['sed', '/x/c Y'], stdinText: 'x\nx\nz\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Y\nY\nz\n');
  });
});

describe('sed negation', () => {
  test('addr! runs command on non-matching lines', async () => {
    const h = makeIO({ args: ['sed', '-n', '2!p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nc\n');
  });
});

describe('sed cycle-engine edge cases (SED-1)', () => {
  test('c ends the cycle: commands after c do not run on stale pattern', async () => {
    const h = makeIO({ args: ['sed', '-n', '2{cFOO\np}'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('FOO\n');
  });

  test('empty regex // reuses the last regex in s///', async () => {
    const h = makeIO({ args: ['sed', '/foo/s//bar/'], stdinText: 'foo\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar\n');
  });

  test('empty regex // reuses the last regex in an address', async () => {
    const h = makeIO({ args: ['sed', '-n', '/b/p;//p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nb\n');
  });

  test('0,/re/ ends on the FIRST line matching re', async () => {
    const h = makeIO({ args: ['sed', '-n', '0,/b/p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('0,/re/ matching on the first line stops immediately', async () => {
    const h = makeIO({ args: ['sed', '-n', '0,/a/p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\n');
  });

  test('zero-length match does not over-fire (a*)', async () => {
    const h = makeIO({ args: ['sed', 's/a*/-/g'], stdinText: 'aaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-\n');
  });

  test('zero-length match interleaving (b*)', async () => {
    const h = makeIO({ args: ['sed', 's/b*/-/g'], stdinText: 'abc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-a-c-\n');
  });

  test('q with exit code arg', async () => {
    const h = makeIO({ args: ['sed', '2q5'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(5);
    expect(h.out()).toBe('a\nb\n');
  });

  test('Q quits without printing the current line', async () => {
    const h = makeIO({ args: ['sed', '2Q5'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(5);
    expect(h.out()).toBe('a\n');
  });

  test('p honors a missing final newline', async () => {
    const h = makeIO({ args: ['sed', '-n', 'p'], stdinText: 'a\nb' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb');
  });
});

describe('sed — case conversion in replacement', () => {
  test('\\U uppercases the rest', async () => {
    const h = makeIO({ args: ['sed', 's/.*/\\U&/'], stdinText: 'hello world\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('HELLO WORLD\n');
  });

  test('\\L lowercases the rest', async () => {
    const h = makeIO({ args: ['sed', 's/.*/\\L&/'], stdinText: 'HELLO\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
  });

  test('\\u uppercases only the next character (per word)', async () => {
    const h = makeIO({ args: ['sed', 's/\\w\\+/\\u&/g'], stdinText: 'hello world\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Hello World\n');
  });

  test('\\l lowercases only the next character', async () => {
    const h = makeIO({ args: ['sed', 's/\\(.\\)/\\l\\1/'], stdinText: 'ABC\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aBC\n');
  });

  test('\\E ends a \\U run', async () => {
    const h = makeIO({ args: ['sed', 's/abc/\\U&\\Edef/'], stdinText: 'abcdef\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ABCdefdef\n');
  });

  test('\\u + \\L combine for title-casing', async () => {
    const h = makeIO({ args: ['sed', 's/\\(\\w\\)\\(\\w*\\)/\\u\\1\\L\\2/g'], stdinText: 'hELLO wORLD\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Hello World\n');
  });
});

describe('sed — buffer anchors, M flag, -z', () => {
  test('\\` anchors to the start of the pattern space', async () => {
    const h = makeIO({ args: ['sed', 'N;s/\\`a/X/'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('X\nb\n');
  });

  test('\\\' anchors to the end of the pattern space', async () => {
    const h = makeIO({ args: ['sed', 'N;s/b\\\'/Y/'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nY\n');
  });

  test('M flag makes ^/$ match at embedded newlines', async () => {
    const h = makeIO({ args: ['sed', 'N;s/^b$/X/M'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nX\n');
  });

  test('M flag with g matches every embedded line start', async () => {
    const h = makeIO({ args: ['sed', 'N;s/^./X/Mg'], stdinText: 'ab\ncd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Xb\nXd\n');
  });

  test('-z treats NUL as the record separator', async () => {
    const h = makeIO({ args: ['sed', '-z', 's/a/X/'], stdinText: 'a b\0c a\0' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('X b\0c X\0');
  });

  test('-z: newlines inside a record can be substituted', async () => {
    const h = makeIO({ args: ['sed', '-z', 's/\\n/,/g'], stdinText: 'a\nb\0c\nd\0' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,b\0c,d\0');
  });

  // CR2: regex-address modifiers I (case-insensitive) and M (multiline).
  test('address regex modifier I matches case-insensitively', async () => {
    const h = makeIO({ args: ['sed', '-n', '/^B/Ip'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('address regex modifier I with a space before the command', async () => {
    const h = makeIO({ args: ['sed', '-n', '/^B/I p'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('address regex modifier M is accepted (matches line b)', async () => {
    const h = makeIO({ args: ['sed', '-n', '/^b/Mp'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('address regex I modifier gating an s/// command', async () => {
    // The address /abc/I matches both lines case-insensitively, but the
    // case-sensitive s/abc/X/ only substitutes (and its p flag only prints) the
    // lowercase line — matching GNU.
    const h = makeIO({ args: ['sed', '-n', '/abc/I s/abc/X/p'], stdinText: 'abc\nABC\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('X\n');
  });

  // CR2: under -z, the M flag must NOT treat embedded \n as ^/$ boundaries —
  // only the true pattern-space start/end anchor.
  test('-z + M: ^ anchors only at the true pattern-space start', async () => {
    const h = makeIO({ args: ['sed', '-z', 's/^./X/Mg'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('X\nb\nc\n');
  });

  test('-z + M: $ anchors only at the true pattern-space end', async () => {
    const h = makeIO({ args: ['sed', '-z', 's/.$/X/Mg'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  test('-z + M: leading ^ insertion fires once (not per embedded line)', async () => {
    const h = makeIO({ args: ['sed', '-z', 's/^/>/Mg'], stdinText: 'a\nb\nc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('>a\nb\nc\n');
  });
});

describe('sed — l / z / F / v and empty a\\ i\\', () => {
  test('l lists the pattern space with escapes and a $ marker', async () => {
    const h = makeIO({ args: ['sed', '-n', 'l'], stdinText: 'a\tb\\c\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\\tb\\\\c$\n');
  });

  test('l with a wrap width breaks long lines with a trailing backslash', async () => {
    const h = makeIO({ args: ['sed', '-n', 'l 5'], stdinText: 'aaaaaaaaaa\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('aaaa\\\naaaa\\\naa$\n');
  });

  test('l 0 disables wrapping', async () => {
    const long = 'x'.repeat(80);
    const h = makeIO({ args: ['sed', '-n', 'l 0'], stdinText: long + '\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe(long + '$\n');
  });

  test('z zaps the pattern space to empty', async () => {
    const h = makeIO({ args: ['sed', 'z'], stdinText: 'abc\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\n');
  });

  test('F prints the current filename', async () => {
    const h = makeIO({ args: ['sed', '-n', 'F', '/f.txt'], files: { '/f.txt': 'x\ny\n' } });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/f.txt\n/f.txt\n');
  });

  test('v is a no-op that does not abort the script', async () => {
    const h = makeIO({ args: ['sed', 'v;s/x/Y/'], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Y\n');
  });

  test('e command (unsupported in sandbox) is a no-op, not a parse error', async () => {
    const h = makeIO({ args: ['sed', 'e echo hi'], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });

  test('bare a\\ at end of script appends nothing', async () => {
    const h = makeIO({ args: ['sed', 'a\\'], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });

  test('bare i\\ at end of script inserts nothing', async () => {
    const h = makeIO({ args: ['sed', 'i\\'], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });

  test('a\\ followed by an empty line appends a blank line', async () => {
    const h = makeIO({ args: ['sed', '-e', 'a\\', '-e', ''], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n\n');
  });
});

describe('sed — file commands r / R / w / W', () => {
  test('r reads a whole file after the cycle', async () => {
    const h = makeIO({ args: ['sed', 'r /rc.txt'], stdinText: 'x\ny\n', files: { '/rc.txt': 'RC1\nRC2\n' } });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nRC1\nRC2\ny\nRC1\nRC2\n');
  });

  test('r on a missing file appends nothing', async () => {
    const h = makeIO({ args: ['sed', 'r /missing'], stdinText: 'x\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\n');
  });

  test('R reads one line of the file per invocation', async () => {
    const h = makeIO({ args: ['sed', 'R /rr.txt'], stdinText: 'x\ny\nz\n', files: { '/rr.txt': 'L1\nL2\n' } });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nL1\ny\nL2\nz\n');
  });

  test('w writes each pattern space to a file', async () => {
    const h = makeIO({ args: ['sed', '-n', 'w /out.txt'], stdinText: 'a\nb\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.files['/out.txt']).toBe('a\nb\n');
  });

  test('s///w writes only the changed lines', async () => {
    const h = makeIO({ args: ['sed', 's/a/X/w /out.txt'], stdinText: 'apple\nbanana\ncherry\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Xpple\nbXnana\ncherry\n');
    expect(h.files['/out.txt']).toBe('Xpple\nbXnana\n');
  });

  test('W writes the first line of a multiline pattern space', async () => {
    const h = makeIO({ args: ['sed', '-n', 'N;W /out.txt'], stdinText: 'a\nb\nc\nd\n' });
    expect(await sedCommand(h.io)).toBe(0);
    expect(h.files['/out.txt']).toBe('a\nc\n');
  });
});
