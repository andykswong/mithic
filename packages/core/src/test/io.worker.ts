import { Worker, workerData } from 'node:worker_threads';
import { IoReactor, RemoteIoProvider, type IoProvider } from '../index.ts';

const isWorker = !!process.env.MITHIC_WORKER;

export function runWorker(): [Worker, IoProvider] {
  const client = new RemoteIoProvider();
  return [new Worker(new URL(import.meta.url), {
    workerData: client.channel,
    env: {
      NODE_NO_WARNINGS: '1',
      MITHIC_WORKER: 'true',
    },
    stdin: true,
    stdout: true,
  }), client];
}

if (isWorker) {
  new IoReactor(workerData);
}
