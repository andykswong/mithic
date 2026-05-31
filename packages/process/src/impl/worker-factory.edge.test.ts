import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultWorkerFactory } from './worker-factory.ts';

describe('WorkerFactory edge cases', () => {
  it('should handle Worker that throws on startup', async () => {
    const factory = createDefaultWorkerFactory();
    const worker = factory.create(new URL('./test-fixtures/throw-worker.ts', import.meta.url));

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('error', () => {});
      worker.on('exit', resolve);
    });

    assert.notEqual(exitCode, 0);
  });

  it('should handle multiple concurrent Workers', async () => {
    const factory = createDefaultWorkerFactory();
    const workers = Array.from({ length: 4 }, () =>
      factory.create(new URL('./test-fixtures/echo-worker.ts', import.meta.url))
    );

    const responses = await Promise.all(workers.map((w, i) =>
      new Promise<unknown>((resolve) => {
        w.on('message', resolve);
        w.postMessage({ type: 'ping', payload: i });
      })
    ));

    for (let i = 0; i < 4; i++) {
      assert.deepEqual(responses[i], { type: 'pong', payload: i });
    }

    await Promise.all(workers.map(w => w.terminate()));
  });

  it('should pass workerData to Worker', async () => {
    const factory = createDefaultWorkerFactory();
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
