/**
 * Unit tests for `xargs`.
 *
 * The command uses `process/pipeline` to spawn child commands. The test harness
 * intercepts that syscall and records what xargs tried to run, so tests stay
 * pure in-process (no real kernel required). E2e tests below (see bottom) prove
 * the syscall path against a real Kernel.
 */
import { expect, test, describe } from 'vitest';
import { xargsCommand } from './xargs.ts';
import type { CommandIO } from '../harness.ts';

// ── harness ───────────────────────────────────────────────────────────────────

interface Invocation {
  argv: string[];
  stdin: string;  // stdin fed to this invocation
}

/** Builds a CommandIO that intercepts process/pipeline calls.
 *  Each pipeline call is recorded; `stdout` bytes are returned as the child output. */
function makeIO(opts: {
  args: string[];
  stdinText?: string;
  /** What stdout text to return from each process/pipeline call, in order. */
  childOutputs?: string[];
  /** If true, simulate child exit code 1 for every call (to test 123 exit code). */
  childExitCode?: number;
}): {
  io: CommandIO;
  out(): string;
  err(): string;
  invocations(): Invocation[];
} {
  const enc = new TextEncoder();

  const stdin = new ReadableStream<Uint8Array>({
    start(c) {
      if (opts.stdinText) c.enqueue(enc.encode(opts.stdinText));
      c.close();
    },
  });

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c.slice()); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c.slice()); } });

  const invocations: Invocation[] = [];
  let callIdx = 0;
  const childOutputs = opts.childOutputs ?? [];
  const childExitCode = opts.childExitCode ?? 0;

  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    if (call === 'process/pipeline') {
      const stages = args.stages as Array<{ path: string; argv: string[]; stdin?: string }>;
      const stage = stages[0];
      invocations.push({ argv: stage.argv, stdin: '' });
      const outputText = childOutputs[callIdx] ?? (stage.argv.slice(1).join(' ') + '\n');
      callIdx++;
      const outBytes = enc.encode(outputText);
      return { exitCodes: [childExitCode], stdout: outBytes };
    }
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
    invocations: () => invocations,
  };
}

// ── default behavior ──────────────────────────────────────────────────────────

describe('xargs default (echo)', () => {
  test('batches all whitespace-separated stdin items into one echo invocation', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: 'a b c\n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(1);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b', 'c']);
  });

  test('newline-separated items are batched together', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: 'a\nb\nc\n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b', 'c']);
  });

  test('extra whitespace and blank lines are ignored', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: '  foo   \n\n  bar  \n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()[0].argv).toEqual(['echo', 'foo', 'bar']);
  });

  test('empty stdin with no -r: runs the command once with no extra args', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: '' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(1);
    expect(h.invocations()[0].argv).toEqual(['echo']);
  });

  test('command output is forwarded to stdout', async () => {
    const h = makeIO({
      args: ['xargs', 'echo'],
      stdinText: 'hello world\n',
      childOutputs: ['hello world\n'],
    });
    await xargsCommand(h.io);
    expect(h.out()).toBe('hello world\n');
  });

  test('explicit command replaces default echo', async () => {
    const h = makeIO({ args: ['xargs', 'cat'], stdinText: 'x\n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()[0].argv).toEqual(['cat', 'x']);
  });

  test('explicit command with initial args', async () => {
    const h = makeIO({ args: ['xargs', 'ls', '-l'], stdinText: '/a /b\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['ls', '-l', '/a', '/b']);
  });
});

// ── -n flag ───────────────────────────────────────────────────────────────────

describe('xargs -n N', () => {
  test('-n 1 spawns one invocation per item', async () => {
    const h = makeIO({ args: ['xargs', '-n', '1'], stdinText: 'a\nb\nc\n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(3);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a']);
    expect(h.invocations()[1].argv).toEqual(['echo', 'b']);
    expect(h.invocations()[2].argv).toEqual(['echo', 'c']);
  });

  test('-n 2 groups items into pairs', async () => {
    const h = makeIO({ args: ['xargs', '-n', '2'], stdinText: 'a b c d e\n' });
    await xargsCommand(h.io);
    expect(h.invocations()).toHaveLength(3);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b']);
    expect(h.invocations()[1].argv).toEqual(['echo', 'c', 'd']);
    expect(h.invocations()[2].argv).toEqual(['echo', 'e']);
  });
});

// ── -L flag ───────────────────────────────────────────────────────────────────

describe('xargs -L N', () => {
  test('-L 1 runs one invocation per input line', async () => {
    const h = makeIO({ args: ['xargs', '-L', '1'], stdinText: 'a b\nc d\n' });
    await xargsCommand(h.io);
    expect(h.invocations()).toHaveLength(2);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b']);
    expect(h.invocations()[1].argv).toEqual(['echo', 'c', 'd']);
  });

  test('-L 2 groups 2 lines per invocation', async () => {
    const h = makeIO({ args: ['xargs', '-L', '2'], stdinText: 'a\nb\nc\nd\n' });
    await xargsCommand(h.io);
    expect(h.invocations()).toHaveLength(2);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b']);
    expect(h.invocations()[1].argv).toEqual(['echo', 'c', 'd']);
  });
});

// ── -I flag ───────────────────────────────────────────────────────────────────

describe('xargs -I REPLSTR', () => {
  test('-I {} substitutes each item into command template', async () => {
    const h = makeIO({ args: ['xargs', '-I', '{}', 'echo', 'item-{}'], stdinText: '1\n2\n3\n' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(3);
    expect(h.invocations()[0].argv).toEqual(['echo', 'item-1']);
    expect(h.invocations()[1].argv).toEqual(['echo', 'item-2']);
    expect(h.invocations()[2].argv).toEqual(['echo', 'item-3']);
  });

  test('-I {} replaces all occurrences in all arg positions', async () => {
    const h = makeIO({ args: ['xargs', '-I', 'X', 'cp', 'X', '/dest/X'], stdinText: 'foo\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['cp', 'foo', '/dest/foo']);
  });

  test('-I implies one item per invocation', async () => {
    const h = makeIO({ args: ['xargs', '-I', '{}', 'echo', '{}'], stdinText: 'a\nb\n' });
    await xargsCommand(h.io);
    expect(h.invocations()).toHaveLength(2);
  });

  test('-I reads each line as one item (whitespace not split)', async () => {
    const h = makeIO({ args: ['xargs', '-I', '{}', 'echo', '{}'], stdinText: 'hello world\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'hello world']);
  });
});

// ── -0 / --null flag ──────────────────────────────────────────────────────────

describe('xargs -0 (NUL-delimited)', () => {
  test('-0 splits on NUL bytes', async () => {
    const h = makeIO({ args: ['xargs', '-0'], stdinText: 'a\0b\0c\0' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b', 'c']);
  });

  test('--null is alias for -0', async () => {
    const h = makeIO({ args: ['xargs', '--null'], stdinText: 'x\0y\0' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'x', 'y']);
  });
});

// ── -d flag ───────────────────────────────────────────────────────────────────

describe('xargs -d DELIM', () => {
  test('-d : splits on colon', async () => {
    const h = makeIO({ args: ['xargs', '-d', ':'], stdinText: 'a:b:c' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b', 'c']);
  });

  test('-d preserves internal whitespace within items', async () => {
    const h = makeIO({ args: ['xargs', '-d', ':'], stdinText: 'hello world:foo\n' });
    await xargsCommand(h.io);
    // With custom delimiter, items are: 'hello world' and 'foo\n' (trailing stripped)
    // The items should be 'hello world' and 'foo'
    expect(h.invocations()[0].argv).toEqual(['echo', 'hello world', 'foo']);
  });
});

// ── -r / --no-run-if-empty ────────────────────────────────────────────────────

describe('xargs -r', () => {
  test('-r skips execution when stdin is empty', async () => {
    const h = makeIO({ args: ['xargs', '-r'], stdinText: '' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(0);
  });

  test('--no-run-if-empty is alias for -r', async () => {
    const h = makeIO({ args: ['xargs', '--no-run-if-empty'], stdinText: '' });
    const code = await xargsCommand(h.io);
    expect(code).toBe(0);
    expect(h.invocations()).toHaveLength(0);
  });

  test('-r still runs when stdin has items', async () => {
    const h = makeIO({ args: ['xargs', '-r'], stdinText: 'x\n' });
    await xargsCommand(h.io);
    expect(h.invocations()).toHaveLength(1);
  });
});

// ── -e / -E EOF string ────────────────────────────────────────────────────────

describe('xargs -E EOF', () => {
  test('-E stops reading at the EOF string', async () => {
    const h = makeIO({ args: ['xargs', '-E', 'STOP'], stdinText: 'a\nb\nSTOP\nc\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b']);
  });

  test('-e without value disables eof string', async () => {
    // -e with empty string disables eof-string matching
    const h = makeIO({ args: ['xargs', '-e', ''], stdinText: 'a\nb\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'a', 'b']);
  });
});

// ── -t (trace) ────────────────────────────────────────────────────────────────

describe('xargs -t', () => {
  test('-t writes command trace to stderr', async () => {
    const h = makeIO({ args: ['xargs', '-t', 'echo'], stdinText: 'x\n' });
    await xargsCommand(h.io);
    expect(h.err()).toContain('echo x');
  });
});

// ── exit codes ────────────────────────────────────────────────────────────────

describe('xargs exit codes', () => {
  test('returns 0 when all child invocations succeed', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: 'a\n', childExitCode: 0 });
    expect(await xargsCommand(h.io)).toBe(0);
  });

  test('returns 123 when any child exits with 1-125', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: 'a\n', childExitCode: 1 });
    expect(await xargsCommand(h.io)).toBe(123);
  });

  test('returns 124 when a child exits 255', async () => {
    const h = makeIO({ args: ['xargs'], stdinText: 'a\n', childExitCode: 255 });
    expect(await xargsCommand(h.io)).toBe(124);
  });

  test('continues running remaining batches even if one fails (exit 123 overall)', async () => {
    // -n 1 means 2 separate invocations; first fails, second should still run
    const h = makeIO({
      args: ['xargs', '-n', '1'],
      stdinText: 'a\nb\n',
      childExitCode: 1,
    });
    const code = await xargsCommand(h.io);
    expect(code).toBe(123);
    expect(h.invocations()).toHaveLength(2);
  });
});

// ── -- separator ──────────────────────────────────────────────────────────────

describe('xargs -- separator', () => {
  test('-- ends flag parsing: next arg is the command', async () => {
    const h = makeIO({ args: ['xargs', '--', 'echo'], stdinText: 'x\n' });
    await xargsCommand(h.io);
    expect(h.invocations()[0].argv).toEqual(['echo', 'x']);
  });
});

// ── e2e test using real Kernel ─────────────────────────────────────────────────

describe('xargs e2e (real Kernel)', () => {
  // Dynamically imported so the test file can run even without a built dist
  // (unit tests above don't need it). The e2e tests are gated to a real kernel.

  test('printf a\\nb\\nc | xargs echo → a b c', async () => {
    const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }, { createCoreutilsResolver }] =
      await Promise.all([
        import('@mithic/kernel'),
        import('@mithic/runtime/backends/worker'),
        import('@mithic/io/vfs'),
        import('../resolver.ts'),
      ]);

    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const resolveCommand = createCoreutilsResolver();
    const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand });

    const PROC_CAP = [{ type: 'process' as const }];
    const FS_READ = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const] }];

    // Produce 'a\nb\nc\n' from a small inline guest, pipe into xargs
    const PRODUCER = `import { createGuest } from '@mithic/guest-runtime';
      export default async (boot) => {
        const g = createGuest(boot);
        const w = g.stdout.getWriter();
        await w.write(new TextEncoder().encode('a\\nb\\nc\\n'));
        await w.close();
        g.exit(0);
      };`;

    const xargsCode = resolveCommand('xargs', '/', {})!;
    const result = await kernel.runPipeline([
      { code: PRODUCER, args: ['producer'] },
      { code: xargsCode, args: ['xargs', 'echo'], capabilities: [...FS_READ, ...PROC_CAP], captureStdout: true },
    ]);
    const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
    const stdout = new TextDecoder().decode(bytes);
    expect(stdout).toBe('a b c\n');
    expect(result.exitCodes[result.exitCodes.length - 1]).toBe(0);
  }, 30000);

  test('printf 1\\n2\\n | xargs -I {} echo item-{} → item-1\\nitem-2', async () => {
    const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }, { createCoreutilsResolver }] =
      await Promise.all([
        import('@mithic/kernel'),
        import('@mithic/runtime/backends/worker'),
        import('@mithic/io/vfs'),
        import('../resolver.ts'),
      ]);

    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const resolveCommand = createCoreutilsResolver();
    const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand });

    const PROC_CAP = [{ type: 'process' as const }];
    const FS_READ = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const] }];

    const PRODUCER = `import { createGuest } from '@mithic/guest-runtime';
      export default async (boot) => {
        const g = createGuest(boot);
        const w = g.stdout.getWriter();
        await w.write(new TextEncoder().encode('1\\n2\\n'));
        await w.close();
        g.exit(0);
      };`;

    const xargsCode = resolveCommand('xargs', '/', {})!;
    const result = await kernel.runPipeline([
      { code: PRODUCER, args: ['producer'] },
      { code: xargsCode, args: ['xargs', '-I', '{}', 'echo', 'item-{}'], capabilities: [...FS_READ, ...PROC_CAP], captureStdout: true },
    ]);
    const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
    const stdout = new TextDecoder().decode(bytes);
    expect(stdout).toBe('item-1\nitem-2\n');
    expect(result.exitCodes[result.exitCodes.length - 1]).toBe(0);
  }, 30000);
});
