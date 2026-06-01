import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerProcessManager } from './worker-manager.ts';
import { CommandRegistry } from './component-registry.ts';
import type { ManagedWorker, WorkerFactory } from '@mithic/io/io/worker-factory';

interface MockWorker extends ManagedWorker {
  handlers: Map<string, ((...args: unknown[]) => void)[]>;
  messages: unknown[];
  simulateExit(code: number): void;
  simulateError(err: Error): void;
}

function createMockWorker(): MockWorker {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const messages: unknown[] = [];
  const worker = {
    handlers,
    messages,
    postMessage(msg: unknown) { messages.push(msg); },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    async terminate() { return 0; },
    simulateExit(code: number) {
      for (const h of handlers.get('exit') ?? []) h(code);
    },
    simulateError(err: Error) {
      for (const h of handlers.get('error') ?? []) h(err);
    },
  };
  return worker as unknown as MockWorker;
}

function createMockWorkerFactory(): WorkerFactory & { workers: MockWorker[] } {
  const workers: MockWorker[] = [];
  return {
    workers,
    create(): ManagedWorker {
      const w = createMockWorker();
      workers.push(w);
      return w;
    },
  };
}

describe('WorkerProcessManager', () => {
  let factory: ReturnType<typeof createMockWorkerFactory>;
  let registry: CommandRegistry;
  let manager: WorkerProcessManager;

  beforeEach(() => {
    factory = createMockWorkerFactory();
    registry = new CommandRegistry({
      precompiled: new Map([
        ['test', {
          commands: new Set(['echo', 'cat', 'head']),
          compileCore: () => null as unknown as WebAssembly.Module,
          instantiate: () => ({ run: { run: () => 0 } }),
        }],
      ]),
    });
    manager = new WorkerProcessManager({
      registry,
      workerFactory: factory,
      processWorkerUrl: new URL('./process-worker.node.ts', import.meta.url),
      maxWorkers: 4,
    });
  });

  it('spawn creates a Worker and returns a Process with a pid', () => {
    const proc = manager.spawn('echo', ['hello']);
    assert.ok(proc.pid() > 0);
    assert.equal(factory.workers.length, 1);
  });

  it('spawn sends a run message to the Worker', () => {
    manager.spawn('echo', ['hello']);
    const msg = factory.workers[0]!.messages[0] as { type: string; args: string[] };
    assert.equal(msg.type, 'run');
    assert.deepEqual(msg.args, ['echo', 'hello']);
  });

  it('spawn passes env and cwd in run message', () => {
    manager.spawn('echo', ['hi'], { env: { FOO: 'bar' }, cwd: '/tmp' });
    const msg = factory.workers[0]!.messages[0] as { env: Record<string, string>; cwd: string };
    assert.deepEqual(msg.env, { FOO: 'bar' });
    assert.equal(msg.cwd, '/tmp');
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

  it('kill with sigkill terminates the Worker', () => {
    const proc = manager.spawn('echo', ['test']);
    const terminateFn = mock.fn(async () => 0);
    factory.workers[0]!.terminate = terminateFn;
    proc.kill('sigkill');
    assert.equal(terminateFn.mock.calls.length, 1);
  });

  it('kill with sigint sends signal number to signal slot', () => {
    const proc = manager.spawn('echo', ['test']);
    proc.kill('sigint');
    const msg = factory.workers[0]!.messages[0] as { signalSlotBuf: SharedArrayBuffer };
    const view = new Int32Array(msg.signalSlotBuf);
    assert.equal(Atomics.load(view, 0), 2);
  });

  it('createPipe returns a working shared pipe', () => {
    const { input, output } = manager.createPipe();
    output.write(new Uint8Array([1, 2, 3]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('dispose terminates all active Workers', () => {
    const terminateFns = Array.from({ length: 3 }, () => mock.fn(async () => 0));
    for (let i = 0; i < 3; i++) {
      manager.spawn('echo', [`${i}`]);
      factory.workers[i]!.terminate = terminateFns[i]!;
    }
    manager[Symbol.dispose]();
    for (const fn of terminateFns) {
      assert.equal(fn.mock.calls.length, 1);
    }
  });

  it('Worker exit frees up slot for new process', () => {
    for (let i = 0; i < 4; i++) {
      manager.spawn('echo', [`${i}`]);
    }
    assert.throws(() => manager.spawn('echo', ['x']));
    factory.workers[0]!.simulateExit(0);
    const proc = manager.spawn('echo', ['new']);
    assert.ok(proc.pid() > 0);
  });

  it('tryWait returns undefined before exit', () => {
    const proc = manager.spawn('echo', ['test']);
    assert.equal(proc.tryWait(), undefined);
  });

  it('tryWait returns exit code after Worker exit sets it', () => {
    const proc = manager.spawn('echo', ['test']);
    const msg = factory.workers[0]!.messages[0] as { exitSlotBuf: SharedArrayBuffer };
    const view = new Int32Array(msg.exitSlotBuf);
    Atomics.store(view, 0, 42);
    Atomics.notify(view, 0);
    assert.equal(proc.tryWait(), 42);
  });

  it('Worker error handler sets exit code 1 when not already exited', () => {
    manager.spawn('echo', ['test']);
    const msg = factory.workers[0]!.messages[0] as { exitSlotBuf: SharedArrayBuffer };
    factory.workers[0]!.simulateError(new Error('boom'));
    const view = new Int32Array(msg.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 1);
  });

  it('Worker exit handler sets exit code 137 when not already exited', () => {
    manager.spawn('echo', ['test']);
    const msg = factory.workers[0]!.messages[0] as { exitSlotBuf: SharedArrayBuffer };
    factory.workers[0]!.simulateExit(1);
    const view = new Int32Array(msg.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 137);
  });

  it('Worker exit handler does not overwrite exit code when already set', () => {
    manager.spawn('echo', ['test']);
    const msg = factory.workers[0]!.messages[0] as { exitSlotBuf: SharedArrayBuffer };
    const view = new Int32Array(msg.exitSlotBuf);
    Atomics.store(view, 0, 42);
    Atomics.notify(view, 0);
    factory.workers[0]!.simulateExit(1);
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
    const msg = factory.workers[0]!.messages[0] as { exitSlotBuf: SharedArrayBuffer };
    manager[Symbol.dispose]();
    const view = new Int32Array(msg.exitSlotBuf);
    assert.equal(Atomics.load(view, 0), 129);
  });
});
