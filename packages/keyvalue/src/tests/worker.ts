import { Worker, workerData, parentPort } from 'node:worker_threads';
import { type KeyValueApiProvider, KeyValueStoreReactor, RemoteKeyValueStore } from '../index.ts';

const isWorker = !!process.env.MITHIC_WORKER;

export function runWorker(): [Worker, KeyValueApiProvider] {
  const client = new RemoteKeyValueStore();
  return [new Worker(new URL(import.meta.url), {
    workerData: client.channel,
    env: {
      MITHIC_WORKER: 'true',
    },
  }), client];
}

if (isWorker) {
  new KeyValueStoreReactor(workerData);
  parentPort?.on('message', () => process.exit()); // keeps the worker alive
}
