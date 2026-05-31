import { Worker } from 'node:worker_threads';
import type { ManagedWorker, WorkerFactory } from './worker-factory.ts';

export class NodeWorkerFactory implements WorkerFactory {
  create(entryPoint: string | URL, options?: { workerData?: unknown; name?: string }): ManagedWorker {
    const worker = new Worker(entryPoint, {
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
