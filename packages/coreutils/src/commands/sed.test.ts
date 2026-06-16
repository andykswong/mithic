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
