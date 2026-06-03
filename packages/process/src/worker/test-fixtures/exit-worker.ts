import '@mithic/worker';

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'run' && msg.exitSlotBuf) {
    const view = new Int32Array(msg.exitSlotBuf);
    Atomics.store(view, 0, msg.exitCode ?? 0);
    Atomics.notify(view, 0);
  }
};
