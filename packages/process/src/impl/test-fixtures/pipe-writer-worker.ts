import { parentPort, workerData } from 'node:worker_threads';

const HEADER_SIZE = 16;
const WRITE_POS = 1;

parentPort?.on('message', (msg: { type: string; data?: number[] }) => {
  if (msg?.type === 'write' && msg.data && workerData?.pipeBuf) {
    const bufferSize: number = workerData.pipeBufSize;
    const control = new Int32Array(workerData.pipeBuf, 0, 4);
    const dataRegion = new Uint8Array(workerData.pipeBuf, HEADER_SIZE);

    const bytes = new Uint8Array(msg.data);
    const wp = Atomics.load(control, WRITE_POS);
    const firstChunk = Math.min(bytes.byteLength, bufferSize - wp);
    dataRegion.set(bytes.subarray(0, firstChunk), wp);
    if (bytes.byteLength > firstChunk) {
      dataRegion.set(bytes.subarray(firstChunk), 0);
    }
    Atomics.store(control, WRITE_POS, (wp + bytes.byteLength) % bufferSize);
    Atomics.notify(control, WRITE_POS);

    if (workerData.exitSlotBuf) {
      const exitView = new Int32Array(workerData.exitSlotBuf);
      Atomics.store(exitView, 0, 0);
      Atomics.notify(exitView, 0);
    }
  }
});
