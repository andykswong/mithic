import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'test-fixtures');

before(async () => {
  await import('./polyfill.ts');
});

describe('Web Worker polyfill', () => {
  it('globalThis.Worker is defined after import', () => {
    assert.ok(globalThis.Worker, 'Worker should be defined on globalThis');
    assert.strictEqual(typeof globalThis.Worker, 'function');
  });

  it('can spawn a worker and exchange messages (echo round-trip)', async () => {
    const worker = new Worker(join(fixtures, 'echo.ts'), { type: 'module' });
    const result = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage('hello');
    });
    assert.strictEqual(result, 'echo: hello');
    await worker.terminate();
  });

  it('supports Transferable (MessagePort transfer)', async () => {
    const worker = new Worker(join(fixtures, 'transfer.ts'), { type: 'module' });
    const { port1, port2 } = new MessageChannel();
    const result = await new Promise<string>((resolve, reject) => {
      port1.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage({ port: port2 }, [port2]);
    });
    assert.strictEqual(result, 'transferred');
    port1.close();
    await worker.terminate();
  });

  it('worker self.close() terminates the worker (fires close event on parent)', async () => {
    const worker = new Worker(join(fixtures, 'close-self.ts'), { type: 'module' });

    // First verify the worker is alive
    const alive = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage('ping');
    });
    assert.strictEqual(alive, 'alive');

    // Now tell it to close and wait for close event
    await new Promise<void>((resolve) => {
      worker.addEventListener('close', () => resolve());
      worker.postMessage('close');
    });
  });

  it('worker.terminate() from parent side works', async () => {
    const worker = new Worker(join(fixtures, 'echo.ts'), { type: 'module' });

    // Give the worker a moment to start
    const result = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage('test');
    });
    assert.strictEqual(result, 'echo: test');

    const exitCode = await worker.terminate();
    assert.strictEqual(exitCode, 1); // Node.js worker_threads returns 1 for forced termination
  });

  it('multiple workers can run concurrently', async () => {
    const worker1 = new Worker(join(fixtures, 'echo.ts'), { type: 'module' });
    const worker2 = new Worker(join(fixtures, 'echo.ts'), { type: 'module' });

    const [r1, r2] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        worker1.onmessage = (e: MessageEvent) => resolve(e.data);
        worker1.onerror = (e) => reject(e);
        worker1.postMessage('one');
      }),
      new Promise<string>((resolve, reject) => {
        worker2.onmessage = (e: MessageEvent) => resolve(e.data);
        worker2.onerror = (e) => reject(e);
        worker2.postMessage('two');
      }),
    ]);

    assert.strictEqual(r1, 'echo: one');
    assert.strictEqual(r2, 'echo: two');
    await worker1.terminate();
    await worker2.terminate();
  });

  it('worker errors propagate to parent onerror/addEventListener(error)', async () => {
    const worker = new Worker(join(fixtures, 'error.ts'), { type: 'module' });

    const error = await new Promise<ErrorEvent>((resolve) => {
      worker.addEventListener('error', (e) => resolve(e as ErrorEvent));
      worker.postMessage('trigger');
    });

    assert.ok(error instanceof ErrorEvent);
    assert.ok(error.message.includes('intentional error'));
    await worker.terminate();
  });

  it('addEventListener/removeEventListener work correctly', async () => {
    const worker = new Worker(join(fixtures, 'echo.ts'), { type: 'module' });
    const messages: string[] = [];

    const handler = (e: Event) => {
      messages.push((e as MessageEvent).data);
    };

    worker.addEventListener('message', handler);
    worker.postMessage('first');

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0], 'echo: first');

    worker.removeEventListener('message', handler);
    worker.postMessage('second');

    await new Promise(resolve => setTimeout(resolve, 100));
    // Should still be 1 since handler was removed
    assert.strictEqual(messages.length, 1);
    await worker.terminate();
  });

  it('messages queued before module sets self.onmessage are delivered after', async () => {
    const worker = new Worker(join(fixtures, 'delayed-handler.ts'), { type: 'module' });

    // Send message immediately — before the worker's 50ms delay finishes
    worker.postMessage('queued');

    const result = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => resolve(e.data);
      worker.onerror = (e) => reject(e);
    });

    assert.strictEqual(result, 'delayed: queued');
    await worker.terminate();
  });
});
