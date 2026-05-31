import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultWorkerFactory } from './worker-factory.ts';

describe('WorkerFactory', () => {
  it('should detect Node.js and create NodeWorkerFactory', () => {
    const factory = createDefaultWorkerFactory();
    assert.equal(factory.constructor.name, 'NodeWorkerFactory');
  });

  it('should create a Worker that responds to messages', async () => {
    const factory = createDefaultWorkerFactory();
    const worker = factory.create(new URL('./test-fixtures/echo-worker.ts', import.meta.url));

    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      worker.on('message', (msg) => { clearTimeout(timeout); resolve(msg); });
      worker.postMessage({ type: 'ping', payload: 42 });
    });

    assert.deepEqual(response, { type: 'pong', payload: 42 });
    await worker.terminate();
  });

  it('should report worker exit', async () => {
    const factory = createDefaultWorkerFactory();
    const worker = factory.create(new URL('./test-fixtures/echo-worker.ts', import.meta.url));

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('exit', resolve);
      worker.terminate();
    });

    assert.equal(exitCode, 1); // terminated
  });
});
