import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleProcessManager, type CommandHandler } from './simple.ts';
import { Process } from '../types.ts';
import { spawnWithPipes } from '../io/pipes.ts';
import { WASIProcess } from '../instantiation.ts';
import { createPipe } from '../io/pipes.ts';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

describe('SimpleProcessManager', () => {
  it('spawn returns Process with correct pid', () => {
    const handler: CommandHandler = async () => 0;
    const mgr = new SimpleProcessManager({ commandResolver: (f) => f === 'echo' ? handler : undefined });
    const proc = mgr.spawn('echo', ['hello']);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid(),1);
  });

  it('spawn with pre-wired stdout captures output', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([1, 2, 3]));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const pipe = mgr.createPipe();
    const proc = mgr.spawn('test', [], { stdout: pipe.output });

    const exitCode = await proc.wait();
    assert.equal(exitCode, 0);

    const data = pipe.input.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('throws not-found when resolver returns undefined', () => {
    const mgr = new SimpleProcessManager({ commandResolver: () => undefined });
    assert.throws(() => mgr.spawn('missing', []), (err: unknown) => err instanceof Error && (err as Error & { payload: { tag: string } }).payload.tag === 'not-found');
  });

  it('passes cwd and env to command context', async () => {
    let capturedCwd = '';
    let capturedEnv: Record<string, string> = {};
    const handler: CommandHandler = async (_args, ctx) => {
      capturedCwd = ctx.cwd;
      capturedEnv = ctx.env;
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', [], { cwd: '/home', env: { FOO: 'bar' } });
    await proc.wait();
    assert.equal(capturedCwd, '/home');
    assert.deepEqual(capturedEnv, { FOO: 'bar' });
  });

  it('spawn inherits manager env when options.env is undefined', async () => {
    let capturedEnv: Record<string, string> = {};
    const handler: CommandHandler = async (_args, ctx) => {
      capturedEnv = ctx.env;
      return 0;
    };
    const hostEnv = { HOME: '/root', PATH: '/usr/bin:/bin' };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler, env: hostEnv });
    const proc = mgr.spawn('test', []);
    await proc.wait();
    assert.deepEqual(capturedEnv, hostEnv);
  });

  it('spawn uses empty env when manager has no env and options.env is undefined', async () => {
    let capturedEnv: Record<string, string> = {};
    const handler: CommandHandler = async (_args, ctx) => {
      capturedEnv = ctx.env;
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    await proc.wait();
    assert.deepEqual(capturedEnv, {});
  });

  it('kill(sigterm) resolves wait with 128+15', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('sleep', ['100']);
    proc.kill('sigterm');
    const exitCode = await proc.wait();
    assert.equal(exitCode, 128 + 15);
  });

  it('kill(sigkill) resolves wait with 128+9', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('sleep', ['100']);
    proc.kill('sigkill');
    const exitCode = await proc.wait();
    assert.equal(exitCode, 128 + 9);
  });

  it('kill(signull) does not kill a running process', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('sleep', ['100']);
    assert.doesNotThrow(() => proc.kill('signull'));
    proc.kill('sigterm');
    const exitCode = await proc.wait();
    assert.equal(exitCode, 128 + 15);
  });

  it('kill(signull) throws for completed process', async () => {
    const handler: CommandHandler = async () => 0;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('true', []);
    await proc.wait();
    assert.throws(() => proc.kill('signull'));
  });

  it('handler error produces exit code 1', async () => {
    const handler: CommandHandler = async () => {
      throw new Error('something went wrong');
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('fail', []);
    await new Promise(r => setTimeout(r, 10));
    const exitCode = proc.tryWait();
    assert.equal(exitCode, 1);
  });

  it('process is removed from table after completion', async () => {
    const handler: CommandHandler = async () => 0;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('echo', []);
    assert.equal(mgr.table.size, 1);
    await proc.wait();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(mgr.table.size, 0);
  });

  it('killed process is removed from table (no zombie)', async () => {
    let resolveCmd: (() => void) | null = null;
    const handler: CommandHandler = () => new Promise<number>(r => { resolveCmd = () => r(0); });
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('long', []);
    assert.equal(mgr.table.size, 1);
    proc.kill('sigterm');
    await proc.wait();
    // Allow microtask to flush the .then/.catch handler
    await new Promise(r => setTimeout(r, 10));
    // After kill, the handler promise may still be pending but table should be cleaned
    // Resolve it to trigger the .then path with killed=true
    resolveCmd!();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(mgr.table.size, 0);
  });

  it('inherits host default streams when not pre-wired', async () => {
    const written: Uint8Array[] = [];
    const hostStreams = {
      stdin: new InputStream({ read() { return undefined; }, blockingRead() { throw { tag: 'closed' }; } }),
      stdout: new OutputStream({ write(data: Uint8Array) { written.push(new Uint8Array(data)); }, checkWrite() { return 1_000_000; } }),
      stderr: new OutputStream({ write() {}, checkWrite() { return 1_000_000; } }),
    };
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([42]));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler, hostStreams });
    const proc = mgr.spawn('test', []);
    await proc.wait();
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([42]));
  });

  it('inherited streams preserve isatty from host streams', async () => {
    const hostStreams = {
      stdin: new InputStream({ read() { return undefined; }, blockingRead() { throw { tag: 'closed' }; } }, undefined, true),
      stdout: new OutputStream({ write() {}, checkWrite() { return 1_000_000; } }, undefined, true),
      stderr: new OutputStream({ write() {}, checkWrite() { return 1_000_000; } }),
    };
    let childStdinIsatty = false;
    let childStdoutIsatty = false;
    let childStderrIsatty = false;
    const handler: CommandHandler = (_args, ctx) => {
      childStdinIsatty = ctx.stdin.isatty;
      childStdoutIsatty = ctx.stdout.isatty;
      childStderrIsatty = ctx.stderr.isatty;
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler, hostStreams });
    const proc = mgr.spawn('test', []);
    await proc.wait();
    assert.equal(childStdinIsatty, true);
    assert.equal(childStdoutIsatty, true);
    assert.equal(childStderrIsatty, false);
  });

  it('createPipe returns linked InputStream and OutputStream', () => {
    const mgr = new SimpleProcessManager();
    const { input, output } = mgr.createPipe();
    assert.ok(input instanceof InputStream);
    assert.ok(output instanceof OutputStream);

    output.write(new Uint8Array([10, 20, 30]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([10, 20, 30]));
  });

  it('tryWait() returns undefined before process completes', () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('sleep', ['100']);
    assert.equal(proc.tryWait(), undefined);
    proc.kill('sigterm');
  });

  it('tryWait() returns exit code after process exits normally', async () => {
    const handler: CommandHandler = async () => 42;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    await proc.wait();
    assert.equal(proc.tryWait(), 42);
  });

  it('tryWait() returns signal exit code after kill', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('sleep', ['100']);
    proc.kill('sigterm');
    await proc.wait();
    assert.equal(proc.tryWait(), 128 + 15);
  });

  it('tryWait() returns 1 after handler error', async () => {
    const handler: CommandHandler = async () => { throw new Error('fail'); };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const pipe = mgr.createPipe();
    const proc = mgr.spawn('fail', [], { stderr: pipe.output });
    await proc.wait();
    assert.equal(proc.tryWait(), 1);
  });

  it('pipe between two processes', async () => {
    const writer: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([65, 66, 67]));
      return 0;
    };
    const reader: CommandHandler = async (_args, ctx) => {
      const data = ctx.stdin.blockingRead(3n) as Uint8Array;
      ctx.stdout.write(data);
      return 0;
    };
    const resolver = (file: string) => {
      if (file === 'writer') return writer;
      if (file === 'reader') return reader;
      return undefined;
    };
    const mgr = new SimpleProcessManager({ commandResolver: resolver });

    const { input: pipeIn, output: pipeOut } = mgr.createPipe();
    const resultPipe = mgr.createPipe();

    const writerProc = mgr.spawn('writer', [], { stdout: pipeOut });
    const readerProc = mgr.spawn('reader', [], { stdin: pipeIn, stdout: resultPipe.output });

    await writerProc.wait();
    await readerProc.wait();

    const result = resultPipe.input.read(3n);
    assert.deepEqual(result, new Uint8Array([65, 66, 67]));
  });
});

describe('SimpleProcessManager async wait', () => {
  it('async handler — wait() returns Promise that resolves with exit code', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10));
      return 42;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    const result = proc.wait();
    assert.ok(result instanceof Promise, 'wait() should return a Promise for async handlers');
    const exitCode = await result;
    assert.equal(exitCode, 42);
  });

  it('sync handler — wait() returns number directly', () => {
    const handler: CommandHandler = () => 7;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    const result = proc.wait();
    assert.equal(typeof result, 'number');
    assert.equal(result, 7);
  });

  it('killed async process — wait() returns 128 + signal number immediately', () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    proc.kill('sigint');
    const result = proc.wait();
    assert.equal(typeof result, 'number');
    assert.equal(result, 128 + 2);
  });

  it('async handler that throws — wait() resolves to 1', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('boom');
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', [], { stderr: mgr.createPipe().output });
    const exitCode = await proc.wait();
    assert.equal(exitCode, 1);
  });

  it('waitAsync() works for async handlers', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10));
      return 99;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    const exitCode = await proc.waitAsync();
    assert.equal(exitCode, 99);
  });

  it('waitAsync() works for sync handlers', async () => {
    const handler: CommandHandler = () => 5;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    const exitCode = await proc.waitAsync();
    assert.equal(exitCode, 5);
  });
});

describe('SimpleProcessManager async wait with delays', () => {
  it('wait() returns Promise for delayed async handler', async () => {
    const resolver = (file: string) => {
      if (file === 'delayed') return async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return 42;
      };
      return undefined;
    };
    const manager = new SimpleProcessManager({ commandResolver: resolver });
    const proc = manager.spawn('delayed', []);

    // Should not be done yet
    assert.equal(proc.tryWait(), undefined);

    const result = proc.wait();
    assert.ok(result instanceof Promise);
    const code = await result;
    assert.equal(code, 42);
  });

  it('waitAsync polls tryWait until done', async () => {
    const resolver = (file: string) => {
      if (file === 'slow') return async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return 7;
      };
      return undefined;
    };
    const manager = new SimpleProcessManager({ commandResolver: resolver });
    const proc = manager.spawn('slow', []);

    const code = await proc.waitAsync();
    assert.equal(code, 7);
  });
});

describe('foreground tracking', () => {
  it('hasForeground is false when no processes are waiting', () => {
    const mgr = new SimpleProcessManager({ commandResolver: () => async () => 0 });
    assert.strictEqual(mgr.hasForeground, false);
  });

  it('hasForeground is false after sync wait() completes', () => {
    // wait() is now sync — adds process to foreground and removes it before returning
    const handler: CommandHandler = () => 0;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    proc.wait();
    assert.strictEqual(mgr.hasForeground, false);
  });

  it('signal delivers to foreground processes during sync wait()', () => {
    // For a sync handler, onKill sets exitCode directly. Signal via kill() is explicit.
    const handler: CommandHandler = () => 0;
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const proc = mgr.spawn('test', []);
    proc.kill('sigint');
    const code = proc.wait();
    assert.strictEqual(code, 130); // 128 + 2 (SIGINT)
  });

  it('signal is no-op when no foreground processes', () => {
    const mgr = new SimpleProcessManager({ commandResolver: () => async () => 0 });
    mgr.signal('sigint'); // should not throw
  });
});

describe('spawnWithPipes', () => {
  it('creates pipes and returns caller ends', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([10, 20, 30]));
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const { process: proc, stdout } = spawnWithPipes(mgr, 'echo', []);

    await proc.wait();

    const output = stdout.read(3n);
    assert.deepEqual(output, new Uint8Array([10, 20, 30]));
  });
});

describe('WASIProcess', () => {
  it('getImportObject exposes mithic:process/manager', () => {
    const wp = new WASIProcess();
    const imports = wp.getImportObject();
    assert.ok('mithic:process/manager' in imports);
    assert.equal(typeof imports['mithic:process/manager'].spawn, 'function');
    assert.equal(typeof imports['mithic:process/manager'].createPipe, 'function');
  });

  it('spawn via getImportObject creates a Process', () => {
    const handler: CommandHandler = async () => 0;
    const wp = new WASIProcess({ commandResolver: (file) => file === 'echo' ? handler : undefined });
    const { spawn } = wp.getImportObject()['mithic:process/manager'];
    const proc = spawn('echo', ['hi']);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid(),1);
  });

  it('spawn throws not-found for unknown command', () => {
    const wp = new WASIProcess();
    const { spawn } = wp.getImportObject()['mithic:process/manager'];
    assert.throws(() => spawn('anything', []), (err: unknown) => err instanceof Error && (err as Error & { payload: { tag: string } }).payload.tag === 'not-found');
  });

  it('accepts custom ProcessManager', async () => {
    let spawnCalled = false;
    const customManager = {
      spawn(_file: string, _args: string[]) {
        spawnCalled = true;
        return new Process(99, { wait: () => 0, tryWait: () => 0 });
      },
      createPipe() {
        const pipe = createPipe();
        return pipe;
      },
      dupOutputStream(stream: OutputStream) {
        return stream.dup();
      },
      signal() {},
      get hasForeground() { return false; },
    };
    const wp = new WASIProcess({ manager: customManager });
    const { spawn } = wp.getImportObject()['mithic:process/manager'];
    const proc = spawn('test', []);
    assert.equal(proc.pid(),99);
    assert.ok(spawnCalled);
  });

  it('two WASIProcess instances are isolated', async () => {
    const handler1: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([1]));
      return 0;
    };
    const handler2: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([2]));
      return 0;
    };
    const wp1 = new WASIProcess({ commandResolver: () => handler1 });
    const wp2 = new WASIProcess({ commandResolver: () => handler2 });

    const [pipe1In, pipe1Out] = wp1.getImportObject()['mithic:process/manager'].createPipe();
    const [pipe2In, pipe2Out] = wp2.getImportObject()['mithic:process/manager'].createPipe();

    const proc1 = wp1.getImportObject()['mithic:process/manager'].spawn('cmd', [], { stdout: pipe1Out });
    const proc2 = wp2.getImportObject()['mithic:process/manager'].spawn('cmd', [], { stdout: pipe2Out });

    await proc1.wait();
    await proc2.wait();

    assert.deepEqual(pipe1In.read(1n), new Uint8Array([1]));
    assert.deepEqual(pipe2In.read(1n), new Uint8Array([2]));
  });

  it('handler dispose signals EOF to pipe reader', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([42]));
      ctx.stdout[Symbol.dispose]();
      return 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const pipe = createPipe({ async: true });
    const proc = mgr.spawn('test', [], { stdout: pipe.output });

    await proc.wait();
    const data = await pipe.input.blockingRead(1n);
    assert.deepEqual(data, new Uint8Array([42]));
    await assert.rejects(async () => pipe.input.blockingRead(1n), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('pipe reader close signals broken-pipe to writer', async () => {
    let brokenPipe = false;
    const handler: CommandHandler = async (_args, ctx) => {
      try {
        for (let i = 0; i < 100; i++) {
          const cap = Number(ctx.stdout.checkWrite());
          if (cap <= 0) break;
          ctx.stdout.write(new Uint8Array(Math.min(cap, 1024)));
        }
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'tag' in e) {
          const err = e as { tag: string; val?: { toDebugString?: () => string } };
          if (err.val?.toDebugString?.() === 'broken-pipe') {
            brokenPipe = true;
          }
        }
      }
      return brokenPipe ? 141 : 0;
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const pipe = createPipe({ async: true });

    pipe.input.close();
    const proc = mgr.spawn('producer', [], { stdout: pipe.output });

    const code = await proc.wait();
    assert.equal(code, 141);
    assert.ok(brokenPipe);
  });
});
