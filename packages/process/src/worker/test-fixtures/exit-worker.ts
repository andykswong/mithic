import { parentPort, workerData } from 'node:worker_threads';

parentPort?.on('message', (msg: { type: string; exitSlotBuf?: SharedArrayBuffer }) => {
  if (msg?.type === 'run' && msg.exitSlotBuf) {
    const view = new Int32Array(msg.exitSlotBuf);
    Atomics.store(view, 0, workerData?.exitCode ?? 0);
    Atomics.notify(view, 0);
  }
});
