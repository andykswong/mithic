import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NodeWorkerFactory } from './worker-factory.node.ts';

describe('NodeWorkerFactory', () => {
  it('should create a Worker that responds to messages', async () => {
    const factory = new NodeWorkerFactory();
    const worker = factory.create(new URL('./test-fixtures/echo-worker.ts', import.meta.url));

    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      worker.on('message', (msg) => { clearTimeout(timeout); resolve(msg); });
      worker.postMessage({ type: 'ping', payload: 42 });
    });

    assert.deepEqual(response, { type: 'pong', payload: 42 });
    await worker.terminate();
  });

  it('should report worker exit on terminate', async () => {
    const factory = new NodeWorkerFactory();
    const worker = factory.create(new URL('./test-fixtures/echo-worker.ts', import.meta.url));

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('exit', resolve);
      worker.terminate();
    });

    assert.equal(exitCode, 1);
  });

  it('should pass workerData to Worker', async () => {
    const factory = new NodeWorkerFactory();
    const worker = factory.create(
      new URL('./test-fixtures/workerdata-worker.ts', import.meta.url),
      { workerData: { secret: 42 } },
    );

    const response = await new Promise<unknown>((resolve) => {
      worker.on('message', resolve);
    });

    assert.deepEqual(response, { secret: 42 });
    await worker.terminate();
  });
});
