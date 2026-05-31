import { Worker as NodeWorkerThread } from 'node:worker_threads';

export interface ManagedWorker {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  on(event: 'message', handler: (msg: unknown) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit', handler: (code: number) => void): void;
  terminate(): Promise<number>;
}

export interface WorkerFactory {
  create(entryPoint: string | URL, options?: { workerData?: unknown; name?: string }): ManagedWorker;
}

export class NodeWorkerFactory implements WorkerFactory {
  create(entryPoint: string | URL, options?: { workerData?: unknown; name?: string }): ManagedWorker {
    const worker = new NodeWorkerThread(entryPoint, {
      execArgv: ['--experimental-strip-types'],
      workerData: options?.workerData,
      name: options?.name,
    });
    let terminating = false;
    return {
      postMessage(msg: unknown, transfer?: Transferable[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        worker.postMessage(msg, transfer as any);
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'exit') {
          worker.on('exit', (code: number) => handler(terminating && code === 0 ? 1 : code));
        } else {
          worker.on(event, handler);
        }
      },
      terminate() {
        terminating = true;
        return worker.terminate().then((code) => code === 0 ? 1 : code);
      },
    } as ManagedWorker;
  }
}

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
        else if (event === 'exit') { /* browser Workers don't emit exit — handled via message protocol */ }
      },
      terminate() { worker.terminate(); return Promise.resolve(1); },
    } as ManagedWorker;
  }
}

export function createDefaultWorkerFactory(): WorkerFactory {
  if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
    return new NodeWorkerFactory();
  }
  return new BrowserWorkerFactory();
}
