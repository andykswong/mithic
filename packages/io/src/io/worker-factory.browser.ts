import type { ManagedWorker, WorkerFactory } from './worker-factory.ts';

export class BrowserWorkerFactory implements WorkerFactory {
  create(entryPoint: string | URL, options?: { workerData?: unknown; name?: string }): ManagedWorker {
    const worker = new globalThis.Worker(entryPoint, { type: 'module', name: options?.name });
    if (options?.workerData !== undefined) {
      worker.postMessage({ __workerData: options.workerData });
    }
    return {
      postMessage(msg: unknown, transfer?: Transferable[]) {
        worker.postMessage(msg, transfer ?? []);
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'message') worker.addEventListener('message', (e) => handler((e as MessageEvent).data));
        else if (event === 'error') worker.addEventListener('error', (e) => handler((e as ErrorEvent).error ?? e));
        else if (event === 'exit') { /* browser Workers don't fire exit — use message protocol */ }
      },
      terminate() { worker.terminate(); return Promise.resolve(1); },
    } as ManagedWorker;
  }
}
