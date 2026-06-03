import '@mithic/worker';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExitSlot } from '../io/slots.ts';
import { createSharedPipeRaw, outputFromSharedBuffer, inputFromSharedBuffer } from '../io/pipes.ts';

describe('WorkerProcessManager integration', () => {
  it('Worker can write exit code to ExitSlot SharedArrayBuffer', async () => {
    const exitSlot = createExitSlot();

    const worker = new Worker(
      new URL('../worker/test-fixtures/exit-worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.postMessage({ type: 'run', exitSlotBuf: exitSlot.buffer, exitCode: 42 });

    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      const check = () => {
        const c = exitSlot.tryWait();
        if (c !== undefined) {
          clearTimeout(timeout);
          resolve(c);
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    assert.equal(code, 42);
    worker.terminate();
  });

  it('SharedPipe data flows between main thread and Worker via SAB', () => {
    const pipe = createSharedPipeRaw(1024);

    const output = outputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    output.write(new Uint8Array([10, 20, 30, 40, 50]));
    output[Symbol.dispose]();

    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    const data = input.blockingRead(5n);
    assert.deepEqual(data, new Uint8Array([10, 20, 30, 40, 50]));
    input[Symbol.dispose]();
  });

  it('cross-thread pipe: Writer in Worker, Reader on main thread', async () => {
    const pipe = createSharedPipeRaw(4096);
    const exitSlot = createExitSlot();

    const worker = new Worker(
      new URL('../worker/test-fixtures/pipe-writer-worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.postMessage({ type: 'init', pipeBuf: pipe.buffer, pipeBufSize: pipe.bufferSize, exitSlotBuf: exitSlot.buffer });
    worker.postMessage({ type: 'write', data: [1, 2, 3, 4, 5] });

    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);

    const data = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      const poll = () => {
        const d = input.read(5n);
        if (d.byteLength > 0) {
          clearTimeout(timeout);
          resolve(d);
        } else {
          setTimeout(poll, 10);
        }
      };
      poll();
    });

    assert.deepEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
    input[Symbol.dispose]();
    worker.terminate();
  });
});
