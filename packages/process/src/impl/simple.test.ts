import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleProcessManager, type CommandHandler } from './simple.ts';
import { Process } from '../types.ts';
import { spawnWithPipes } from '../utils.ts';
import { WASIProcess } from '../instantiation.ts';
import { createPipe } from '../utils.ts';
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

  it('handler error produces exit code 1 and writes to stderr', async () => {
    const handler: CommandHandler = async () => {
      throw new Error('something went wrong');
    };
    const mgr = new SimpleProcessManager({ commandResolver: () => handler });
    const stderrPipe = mgr.createPipe();
    const proc = mgr.spawn('fail', [], { stderr: stderrPipe.output });
    const exitCode = await proc.wait();
    assert.equal(exitCode, 1);
    const errData = stderrPipe.input.read(4096n);
    const errMsg = new TextDecoder().decode(errData);
    assert.ok(errMsg.includes('something went wrong'));
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

  it('inherits host default streams when not pre-wired', async () => {
    const written: Uint8Array[] = [];
    const hostStreams = {
      stdin: { read() { return undefined; }, blockingRead() { throw { tag: 'closed' }; } },
      stdout: { write(data: Uint8Array) { written.push(new Uint8Array(data)); }, checkWrite() { return 1_000_000; } },
      stderr: { write() {}, checkWrite() { return 1_000_000; } },
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
      const data = ctx.stdin.blockingRead(3n);
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
        return new Process(99, { wait: () => Promise.resolve(0) });
      },
      createPipe() {
        const pipe = createPipe();
        return pipe;
      },
      dupOutputStream(stream: OutputStream) {
        return stream.dup();
      },
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
});
