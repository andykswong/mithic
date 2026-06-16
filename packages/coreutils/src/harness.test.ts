import { expect, test, describe } from 'vitest';
import {
  parseArgs,
  readAll,
  readAllText,
  readLines,
  writeBytes,
  writeString,
  writeLine,
  exitWith,
  defineCommand,
} from './harness.ts';
import type { CommandIO } from './harness.ts';

// ── helpers to build in-memory streams for tests ───────────────────────────

function streamFrom(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function streamFromText(s: string): ReadableStream<Uint8Array> {
  return streamFrom(new TextEncoder().encode(s));
}

function collectingStream(): { stream: WritableStream<Uint8Array>; text(): string } {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) { chunks.push(chunk); },
  });
  return {
    stream,
    text() {
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return new TextDecoder().decode(buf);
    },
  };
}

// ── parseArgs ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('separates positionals from short boolean flags', () => {
    const r = parseArgs(['-n', 'file.txt'], { boolean: ['n'] });
    expect(r.flags.n).toBe(true);
    expect(r.positionals).toEqual(['file.txt']);
  });

  test('clusters combined short flags (-abc → a,b,c)', () => {
    const r = parseArgs(['-abc'], { boolean: ['a', 'b', 'c'] });
    expect(r.flags.a).toBe(true);
    expect(r.flags.b).toBe(true);
    expect(r.flags.c).toBe(true);
  });

  test('a short flag taking a value consumes the rest of the cluster', () => {
    const r = parseArgs(['-ovalue'], { string: ['o'] });
    expect(r.flags.o).toBe('value');
  });

  test('a short flag taking a value consumes the next arg when cluster ends', () => {
    const r = parseArgs(['-o', 'value'], { string: ['o'] });
    expect(r.flags.o).toBe('value');
  });

  test('long boolean flag --flag', () => {
    const r = parseArgs(['--number', 'x'], { boolean: ['number'] });
    expect(r.flags.number).toBe(true);
    expect(r.positionals).toEqual(['x']);
  });

  test('long flag with inline value --flag=val', () => {
    const r = parseArgs(['--output=out.txt'], { string: ['output'] });
    expect(r.flags.output).toBe('out.txt');
  });

  test('long flag with separate value --flag val', () => {
    const r = parseArgs(['--output', 'out.txt'], { string: ['output'] });
    expect(r.flags.output).toBe('out.txt');
  });

  test('-- terminator: everything after is positional', () => {
    const r = parseArgs(['-n', '--', '-n', '--foo'], { boolean: ['n'] });
    expect(r.flags.n).toBe(true);
    expect(r.positionals).toEqual(['-n', '--foo']);
  });

  test('a lone "-" is a positional (stdin convention), not a flag', () => {
    const r = parseArgs(['-'], { boolean: ['n'] });
    expect(r.positionals).toEqual(['-']);
  });

  test('aliases map long names to canonical short flag', () => {
    const r = parseArgs(['--number'], { boolean: ['n'], alias: { number: 'n' } });
    expect(r.flags.n).toBe(true);
  });

  test('unknown flag is recorded but does not throw by default', () => {
    const r = parseArgs(['-x'], {});
    expect(r.flags.x).toBe(true);
  });

  test('repeated flags can be collected as a count when requested', () => {
    const r = parseArgs(['-vvv'], { boolean: ['v'], count: ['v'] });
    expect(r.flags.v).toBe(3);
  });
});

// ── stream helpers ──────────────────────────────────────────────────────────

describe('stream read helpers', () => {
  test('readAll concatenates all chunks into one Uint8Array', async () => {
    const bytes = await readAll(streamFrom(
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
    ));
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  test('readAllText decodes UTF-8', async () => {
    expect(await readAllText(streamFromText('héllo'))).toBe('héllo');
  });

  test('readLines splits on newlines, dropping a trailing empty line', async () => {
    expect(await readLines(streamFromText('a\nb\nc\n'))).toEqual(['a', 'b', 'c']);
  });

  test('readLines keeps a final line with no trailing newline', async () => {
    expect(await readLines(streamFromText('a\nb'))).toEqual(['a', 'b']);
  });
});

describe('stream write helpers', () => {
  test('writeString writes raw text without a newline', async () => {
    const c = collectingStream();
    const w = c.stream.getWriter();
    await writeString(w, 'abc');
    await w.close();
    expect(c.text()).toBe('abc');
  });

  test('writeLine appends a newline', async () => {
    const c = collectingStream();
    const w = c.stream.getWriter();
    await writeLine(w, 'abc');
    await w.close();
    expect(c.text()).toBe('abc\n');
  });

  test('writeBytes writes raw bytes', async () => {
    const c = collectingStream();
    const w = c.stream.getWriter();
    await writeBytes(w, new Uint8Array([65, 66]));
    await w.close();
    expect(c.text()).toBe('AB');
  });
});

// ── exitWith ─────────────────────────────────────────────────────────────────

describe('exitWith', () => {
  test('returns the code and writes the message to stderr with a newline', async () => {
    const c = collectingStream();
    const w = c.stream.getWriter();
    const code = await exitWith(w, 2, 'cat: boom');
    await w.close();
    expect(code).toBe(2);
    expect(c.text()).toBe('cat: boom\n');
  });

  test('with no message just returns the code', async () => {
    const c = collectingStream();
    const w = c.stream.getWriter();
    const code = await exitWith(w, 0);
    await w.close();
    expect(code).toBe(0);
    expect(c.text()).toBe('');
  });
});

// ── defineCommand: turns a CommandFn into a guest default export ─────────────

describe('defineCommand', () => {
  test('produces a guest default that wires createGuest IO and exits with the fn code', async () => {
    // A trivial command: echoes argv[1..] joined, returns 7.
    const fn = async (io: CommandIO): Promise<number> => {
      const w = io.stdout.getWriter();
      await writeString(w, io.args.slice(1).join(' '));
      await w.close();
      return 7;
    };
    const guestDefault = defineCommand(fn);
    expect(typeof guestDefault).toBe('function');

    // Drive it with a hand-built boot wiring (a control MessageChannel + stdio).
    const out = collectingStream();
    const exits: number[] = [];
    // A fake "guest" object: defineCommand calls createGuest(boot); to test in
    // isolation we let it accept an injected guest factory. The default export
    // must work with the real boot shape too (proven by the e2e test).
    const { boot, drained } = makeFakeBoot({ args: ['echo', 'hi', 'there'], stdout: out.stream, onExit: (c) => exits.push(c) });
    await guestDefault(boot);
    await drained; // wait for the stdout pipe to flush + close
    expect(out.text()).toBe('hi there');
    expect(exits).toEqual([7]);
  });
});

// Build a boot object that createGuest accepts, using a real MessageChannel for
// control and real preopen ports backed by the provided streams. This proves
// defineCommand works against the actual createGuest contract, not a mock.
function makeFakeBoot(opts: {
  args: string[];
  stdout: WritableStream<Uint8Array>;
  onExit: (code: number) => void;
}): { boot: unknown; drained: Promise<void> } {
  const control = new MessageChannel();
  // The guest posts {type:'exit', code} over control; observe it.
  control.port1.start?.();
  control.port1.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: string; code?: number };
    if (m?.type === 'exit') opts.onExit(m.code ?? 0);
  };
  // stdout: a pipe whose write end goes to the guest, read end drains to stream.
  const stdoutChan = new MessageChannel();
  const drained = pumpPortToWritable(stdoutChan.port1, opts.stdout);
  const boot = {
    control: control.port2,
    init: {
      type: 'init',
      entry: 'inline',
      args: opts.args,
      env: {},
      cwd: '/',
      pid: 1,
      ppid: 0,
      capabilities: [],
      preopens: { 1: { type: 'pipe' } },
    },
    preopenPorts: { 1: stdoutChan.port2 },
  };
  return { boot, drained };
}

// Minimal kernel-side drain of the guest-runtime pipe protocol: grant credit,
// forward data chunks to the writable, close on end. Resolves when the stream
// has been flushed and closed (mirrors the kernel's drainPort).
function pumpPortToWritable(port: MessagePort, writable: WritableStream<Uint8Array>): Promise<void> {
  const writer = writable.getWriter();
  port.start?.();
  port.postMessage({ type: 'credit', bytes: 1 << 24 });
  return new Promise<void>((resolve) => {
    const writes: Promise<void>[] = [];
    port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; chunk?: Uint8Array };
      if (m?.type === 'data' && m.chunk) { writes.push(writer.write(m.chunk)); }
      else if (m?.type === 'end') {
        void Promise.all(writes)
          .then(() => writer.close().catch(() => { /* closed */ }))
          .finally(() => { port.close(); resolve(); });
      }
    };
  });
}
