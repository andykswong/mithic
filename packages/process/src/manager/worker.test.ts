import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerProcessManager } from './worker.ts';
import type { ProcessWorker, RunOptions } from '../types.ts';

interface MockProcessWorker extends ProcessWorker {
  handlers: Map<string, (() => void)[]>;
  runCalls: Array<{ options: RunOptions; transfer: Transferable[] }>;
  simulateClose(): void;
  simulateError(): void;
}

function createMockProcessWorker(): MockProcessWorker {
  const handlers = new Map<string, (() => void)[]>();
  const runCalls: Array<{ options: RunOptions; transfer: Transferable[] }> = [];
  const worker: MockProcessWorker = {
    handlers,
    runCalls,
    run(options: RunOptions, transfer: Transferable[]) { runCalls.push({ options, transfer }); },
    terminate: mock.fn(() => {}),
    addEventListener(type: 'error' | 'close', handler: () => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    simulateClose() {
      for (const h of handlers.get('close') ?? []) h();
    },
    simulateError() {
      for (const h of handlers.get('error') ?? []) h();
    },
  };
  return worker;
}

describe('WorkerProcessManager', () => {
  let workers: MockProcessWorker[];
  let manager: WorkerProcessManager;

  beforeEach(() => {
    workers = [];
    manager = new WorkerProcessManager({
      createWorker: (file: string, _name?: string) => {
        if (['echo', 'cat', 'head'].includes(file)) {
          const w = createMockProcessWorker();
          workers.push(w);
          return w;
        }
        return undefined;
      },
      maxWorkers: 4,
    });
  });

  it('spawn creates a ProcessWorker and returns a Process with a pid', () => {
    const proc = manager.spawn('echo', ['hello']);
    assert.ok(proc.pid() > 0);
    assert.equal(workers.length, 1);
  });

  it('spawn sends run options with args to the ProcessWorker', () => {
    manager.spawn('echo', ['hello']);
    const call = workers[0]!.runCalls[0]!;
    assert.deepEqual(call.options.args, ['echo', 'hello']);
  });

  it('spawn passes env and cwd in run options', () => {
    manager.spawn('echo', ['hi'], { env: { FOO: 'bar' }, cwd: '/tmp' });
    const call = workers[0]!.runCalls[0]!;
    assert.deepEqual(call.options.env, { FOO: 'bar' });
    assert.equal(call.options.cwd, '/tmp');
  });

  it('spawn throws not-found for unknown commands', () => {
    assert.throws(
      () => manager.spawn('nonexistent', []),
      (err: Error) => err.message.includes('not found'),
    );
  });

  it('spawn throws resource-exhausted when maxWorkers reached', () => {
    for (let i = 0; i < 4; i++) {
      manager.spawn('echo', [`${i}`]);
    }
    assert.throws(
      () => manager.spawn('echo', ['overflow']),
      (err: Error) => err.message.includes('max'),
    );
  });

  it('kill with sigkill terminates the ProcessWorker', () => {
    const proc = manager.spawn('echo', ['test']);
    proc.kill('sigkill');
    assert.equal((workers[0]!.terminate as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('kill with sigint sends signal number to signal slot', () => {
    const proc = manager.spawn('echo', ['test']);
    proc.kill('sigint');
    const call = workers[0]!.runCalls[0]!;
    const view = new Int32Array(call.options.signalSlotBuf);
    assert.equal(Atomics.load(view, 0), 2);
  });

  it('createPipe returns a working shared pipe', () => {
    const { input, output } = manager.createPipe();
    output.write(new Uint8Array([1, 2, 3]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('spawn uses caller-provided pipe handles from createPipe', () => {
    const { input, output } = manager.createPipe();
    // Spawn with the pipe as stdout
    manager.spawn('echo', ['test'], { stdout: output });
    const call = workers[0]!.runCalls[0]!;
    // The ProcessWorker should get the same SAB that backs our pipe
    // Verify by writing to the SAB from "worker side" and reading from input
    const HEADER_SIZE = 16;
    const WRITE_POS = 1;
    const control = new Int32Array(call.options.stdoutBuf, 0, 4);
    const data = new Uint8Array(call.options.stdoutBuf, HEADER_SIZE);
    data[0] = 99;
    Atomics.store(control, WRITE_POS, 1);
    Atomics.notify(control, WRITE_POS);
    const read = input.read(1n);
    assert.deepEqual(read, new Uint8Array([99]));
  });

  it('dispose terminates all active ProcessWorkers', () => {
    for (let i = 0; i < 3; i++) {
      manager.spawn('echo', [`${i}`]);
    }
    manager[Symbol.dispose]();
    for (const w of workers) {
      assert.equal((w.terminate as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    }
  });

  it('ProcessWorker close frees up slot for new process', () => {
    for (let i = 0; i < 4; i++) {
      manager.spawn('echo', [`${i}`]);
    }
    assert.throws(() => manager.spawn('echo', ['x']));
    workers[0]!.simulateClose();
    const proc = manager.spawn('echo', ['new']);
    assert.ok(proc.pid() > 0);
  });

  it('tryWait returns undefined before exit', () => {
    const proc = manager.spawn('echo', ['test']);
    assert.equal(proc.tryWait(), undefined);
  });

  it('tryWait returns exit code after exit slot is set', () => {
    const proc = manager.spawn('echo', ['test']);
    const call = workers[0]!.runCalls[0]!;
    const view = new Int32Array(call.options.exitSlotBuf);
    Atomics.store(view, 0, 42);
    Atomics.notify(view, 0);
    assert.equal(proc.tryWait(), 42);
  });

  it('ProcessWorker error handler sets exit code 1 when not already exited', () => {
    manager.spawn('echo', ['test']);
    const call = workers[0]!.runCalls[0]!;
    workers[0]!.simulateError();
    const view = new Int32Array(call.options.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 1);
  });

  it('ProcessWorker close handler sets exit code 137 when not already exited', () => {
    manager.spawn('echo', ['test']);
    const call = workers[0]!.runCalls[0]!;
    workers[0]!.simulateClose();
    const view = new Int32Array(call.options.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 137);
  });

  it('ProcessWorker close handler does not overwrite exit code when already set', () => {
    manager.spawn('echo', ['test']);
    const call = workers[0]!.runCalls[0]!;
    const view = new Int32Array(call.options.exitSlotBuf);
    Atomics.store(view, 0, 42);
    Atomics.notify(view, 0);
    workers[0]!.simulateClose();
    assert.equal(Atomics.load(view, 0), 42);
  });

  it('hasForeground is false initially', () => {
    assert.equal(manager.hasForeground, false);
  });

  it('signal is no-op when no foreground processes', () => {
    manager.signal('sigint');
  });

  it('pids increment for each spawn', () => {
    const p1 = manager.spawn('echo', ['a']);
    const p2 = manager.spawn('echo', ['b']);
    assert.equal(p1.pid(), 1);
    assert.equal(p2.pid(), 2);
  });

  it('dispose sets exit code 129 for processes that have not exited', () => {
    manager.spawn('echo', ['test']);
    const call = workers[0]!.runCalls[0]!;
    manager[Symbol.dispose]();
    const view = new Int32Array(call.options.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 129);
  });

  it('dupOutputStream preserves pipe handle association', () => {
    const { output } = manager.createPipe();
    const duped = manager.dupOutputStream(output);
    // Both output and duped should be associated with the same SAB
    manager.spawn('echo', ['test'], { stdout: duped });
    const call = workers[0]!.runCalls[0]!;
    assert.ok(call.options.stdoutBuf instanceof SharedArrayBuffer);
    assert.ok(call.options.stdoutBufSize > 0);
  });
});
