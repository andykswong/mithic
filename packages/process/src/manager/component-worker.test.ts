import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ComponentProcessWorker } from './component-worker.ts';
import { createExitSlot, createSignalSlot } from '../io/slots.ts';
import { createSharedPipeRaw } from '../io/pipes.ts';
import type { RunOptions } from '../types.ts';
import type { CompileResult } from '../component/compiler.ts';

function createMockWorker() {
  const posted: { data: unknown; transfer: Transferable[] }[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let terminated = false;

  return {
    posted,
    listeners,
    get terminated() { return terminated; },
    worker: {
      postMessage(data: unknown, transfer?: Transferable[]) {
        posted.push({ data, transfer: transfer ?? [] });
      },
      addEventListener(type: string, handler: () => void) {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
      },
      terminate() { terminated = true; },
    } as unknown as Worker,
  };
}

function createTestRunOptions(): RunOptions {
  const exitSlot = createExitSlot();
  const signalSlot = createSignalSlot();
  const stdin = createSharedPipeRaw(1024);
  const stdout = createSharedPipeRaw(1024);
  const stderr = createSharedPipeRaw(1024);
  return {
    args: ['test-cmd', '--flag'],
    env: { PATH: '/bin' },
    cwd: '/tmp',
    exitSlotBuf: exitSlot.buffer,
    signalSlotBuf: signalSlot.buffer,
    stdinBuf: stdin.buffer,
    stdinBufSize: stdin.bufferSize,
    stdoutBuf: stdout.buffer,
    stdoutBufSize: stdout.bufferSize,
    stderrBuf: stderr.buffer,
    stderrBufSize: stderr.bufferSize,
  };
}

describe('ComponentProcessWorker', () => {
  const testCompileResult: CompileResult = {
    modules: { 'core.wasm': new Uint8Array([0, 97, 115, 109]) },
    jsFiles: { 'component.js': 'export function instantiate(){}' },
    cached: false,
  };

  it('posts run message with compileResult and options', () => {
    const mock = createMockWorker();
    const pw = new ComponentProcessWorker(mock.worker, testCompileResult);
    const opts = createTestRunOptions();

    pw.run(opts, []);

    assert.strictEqual(mock.posted.length, 1);
    const msg = mock.posted[0].data as Record<string, unknown>;
    assert.strictEqual(msg.type, 'run');
    assert.deepStrictEqual(msg.args, ['test-cmd', '--flag']);
    assert.deepStrictEqual(msg.compileResult, testCompileResult);
    assert.strictEqual(msg.cwd, '/tmp');
  });

  it('passes transfer list to postMessage', () => {
    const mock = createMockWorker();
    const pw = new ComponentProcessWorker(mock.worker, testCompileResult);
    const opts = createTestRunOptions();
    const { port1, port2 } = new MessageChannel();

    pw.run(opts, [port1, port2]);

    assert.strictEqual(mock.posted[0].transfer.length, 2);
  });

  it('terminate delegates to worker', () => {
    const mock = createMockWorker();
    const pw = new ComponentProcessWorker(mock.worker, testCompileResult);

    pw.terminate();

    assert.strictEqual(mock.terminated, true);
  });

  it('addEventListener registers on worker', () => {
    const mock = createMockWorker();
    const pw = new ComponentProcessWorker(mock.worker, testCompileResult);
    let closeCalled = false;

    pw.addEventListener('close', () => { closeCalled = true; });

    const handlers = mock.listeners.get('close');
    assert.ok(handlers && handlers.length === 1);
    handlers[0]();
    assert.strictEqual(closeCalled, true);
  });

  it('addEventListener error registers on worker', () => {
    const mock = createMockWorker();
    const pw = new ComponentProcessWorker(mock.worker, testCompileResult);
    let errorCalled = false;

    pw.addEventListener('error', () => { errorCalled = true; });

    const handlers = mock.listeners.get('error');
    assert.ok(handlers && handlers.length === 1);
    handlers[0]();
    assert.strictEqual(errorCalled, true);
  });
});
