import { expect, test, describe } from 'vitest';
import { tacCommand, tacText } from './tac.ts';
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

  test('no trailing newline: no spurious newline added', async () => {
    // records a\n , b → reversed b + a\n = "ba\n"
    const h = makeIO({ args: ['tac'], stdinText: 'a\nb' });
    await tacCommand(h.io);
    expect(h.out()).toBe('ba\n');
  });

  test('three lines, no trailing newline', async () => {
    const h = makeIO({ args: ['tac'], stdinText: 'a\nb\nc' });
    await tacCommand(h.io);
    expect(h.out()).toBe('cb\na\n');
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

  // ── -s separator (GNU parity) ────────────────────────────────────────────

  test('-s custom separator, no trailing sep', async () => {
    const h = makeIO({ args: ['tac', '-s', ':'], stdinText: 'a:b:c' });
    expect(await tacCommand(h.io)).toBe(0);
    // records a: , b: , c → reversed c + b: + a: = "cb:a:"
    expect(h.out()).toBe('cb:a:');
  });

  test('-s custom separator, trailing sep dropped', async () => {
    const h = makeIO({ args: ['tac', '-s', ':'], stdinText: 'a:b:c:' });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c:b:a:');
  });

  test('-s multi-char separator', async () => {
    const h = makeIO({ args: ['tac', '-s', 'XX'], stdinText: 'aXXbXXc' });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cbXXaXX');
  });

  test('-s treats a regex-special separator literally', async () => {
    const h = makeIO({ args: ['tac', '-s', '.'], stdinText: 'a.b.c' });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cb.a.');
  });

  // ── -b before mode ────────────────────────────────────────────────────────

  test('-b attaches the separator to the following record', async () => {
    const h = makeIO({ args: ['tac', '-b'], stdinText: 'a\nb\nc\n' });
    expect(await tacCommand(h.io)).toBe(0);
    // records: a, \nb, \nc, \n → reversed \n + \nc + \nb + a = "\n\nc\nba"
    expect(h.out()).toBe('\n\nc\nba');
  });

  // ── -r regex ──────────────────────────────────────────────────────────────

  test('-r treats separator as a regex', async () => {
    const h = makeIO({ args: ['tac', '-r', '-s', '[0-9]'], stdinText: 'a1b2c3' });
    expect(await tacCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c3b2a1');
  });

  test('-r with an invalid regex errors and exits 1', async () => {
    const h = makeIO({ args: ['tac', '-r', '-s', '['], stdinText: 'ab' });
    expect(await tacCommand(h.io)).toBe(1);
    expect(h.err()).toContain('Invalid regular expression');
  });

  // ── unknown-flag reject ─────────────────────────────────────────────────────

  test('unknown flag → invalid option, exit 1', async () => {
    const h = makeIO({ args: ['tac', '-Z'], stdinText: 'x\n' });
    expect(await tacCommand(h.io)).toBe(1);
    expect(h.err()).toBe('tac: invalid option -- \'Z\'\nTry \'tac --help\' for more information.\n');
  });

  describe('tacText', () => {
    test('trailing mode keeps separators with preceding record', () => {
      expect(tacText('a\nb\nc\n', /\n/, false)).toBe('c\nb\na\n');
    });
    test('trailing mode, unterminated last record', () => {
      expect(tacText('a\nb\nc', /\n/, false)).toBe('cb\na\n');
    });
    test('before mode leads with the separator', () => {
      expect(tacText('a\nb\nc\n', /\n/, true)).toBe('\n\nc\nba');
    });
    test('empty input', () => { expect(tacText('', /\n/, false)).toBe(''); });
  });
});
