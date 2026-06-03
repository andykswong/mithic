import '@mithic/worker';

const HEADER_SIZE = 16;
const WRITE_POS = 1;

let pipeBuf: SharedArrayBuffer | undefined;
let pipeBufSize: number | undefined;
let exitSlotBuf: SharedArrayBuffer | undefined;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'init') {
    pipeBuf = msg.pipeBuf;
    pipeBufSize = msg.pipeBufSize;
    exitSlotBuf = msg.exitSlotBuf;
    return;
  }
  if (msg?.type === 'write' && msg.data && pipeBuf && pipeBufSize) {
    const bufferSize = pipeBufSize;
    const control = new Int32Array(pipeBuf, 0, 4);
    const dataRegion = new Uint8Array(pipeBuf, HEADER_SIZE);

    const bytes = new Uint8Array(msg.data);
    const wp = Atomics.load(control, WRITE_POS);
    const firstChunk = Math.min(bytes.byteLength, bufferSize - wp);
    dataRegion.set(bytes.subarray(0, firstChunk), wp);
    if (bytes.byteLength > firstChunk) {
      dataRegion.set(bytes.subarray(firstChunk), 0);
    }
    Atomics.store(control, WRITE_POS, (wp + bytes.byteLength) % bufferSize);
    Atomics.notify(control, WRITE_POS);

    if (exitSlotBuf) {
      const exitView = new Int32Array(exitSlotBuf);
      Atomics.store(exitView, 0, 0);
      Atomics.notify(exitView, 0);
    }
  }
};
