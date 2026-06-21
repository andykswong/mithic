import {
  isPipeMessage,
  PipeReader,
  PipeWriter,
  PIPE_FLUSH_BYTES,
  PIPE_FLUSH_MS,
  TRANSFER_THRESHOLD_BYTES,
} from '@mithic/protocol';
import type { PipeMessage } from '@mithic/protocol';

/**
 * Wraps a MessagePort (writable side) as a WritableStream<Uint8Array>.
 *
 * C1: credit accounting + the STICKY broken-pipe latch + FIFO waiter wakeup are
 * owned by the shared {@link PipeWriter} primitive. This stream layers ONLY its
 * buffering / flush-timer / ArrayBuffer-transfer policy on top: it observes the
 * port's `credit`/`end`/`error` messages and drives the primitive, and parks on
 * `writer.reserve(n)` before posting each chunk.
 */
export function portToWritable(port: MessagePort): WritableStream<Uint8Array> {
  port.start?.();
  const flow = new PipeWriter();

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (!isPipeMessage(msg)) return;
    if (msg.type === 'credit') {
      flow.addCredit(msg.bytes);
    } else if (msg.type === 'end' || msg.type === 'error') {
      // Reader cancelled or peer sent EPIPE. Latch the STICKY broken flag so every
      // subsequent write rejects at once, and wake all parked writers now so they
      // don't hang forever waiting for credit that will never arrive.
      flow.markBroken(msg.type === 'error' ? msg.code : 'EPIPE');
    }
  };

  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return flow.broken ? Promise.reject(flow.brokenError()) : Promise.resolve();
    const chunks = buf;
    buf = [];
    bufSize = 0;

    return (async () => {
      for (const chunk of chunks) {
        // reserve() rejects immediately if the pipe is (or becomes) broken, and
        // otherwise parks until the reader has granted enough credit for this
        // chunk — deducting it on resolve. The sticky latch lives in PipeWriter.
        await flow.reserve(chunk.byteLength);
        const msg: PipeMessage = { type: 'data', chunk };
        const transfer = chunk.byteLength >= TRANSFER_THRESHOLD_BYTES ? [chunk.buffer as ArrayBuffer] : [];
        port.postMessage(msg, transfer);
      }
    })();
  }

  return new WritableStream<Uint8Array>({
    write(chunk) {
      // Sticky broken: reject IMMEDIATELY (do not buffer, park, or arm a timer).
      // This is the top-of-write guard that stops an unbounded producer the
      // moment the downstream has gone away.
      if (flow.broken) return Promise.reject(flow.brokenError());
      buf.push(chunk);
      bufSize += chunk.byteLength;
      if (bufSize >= PIPE_FLUSH_BYTES) return flushNow();
      if (flushTimer === null) {
        return new Promise<void>((resolve, reject) => {
          flushTimer = setTimeout(() => { flushNow().then(resolve, reject); }, PIPE_FLUSH_MS);
        });
      }
      return Promise.resolve();
    },
    close() {
      return flushNow().then(() => {
        const msg: PipeMessage = { type: 'end' };
        port.postMessage(msg);
        port.close();
      });
    },
    abort() {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      const msg: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(msg);
      port.close();
    },
  });
}

/**
 * Wraps a MessagePort (readable side) as a ReadableStream<Uint8Array>.
 *
 * C1: the sliding credit-window policy is owned by the shared {@link PipeReader}
 * primitive (open the window on first pull, replenish only what the consumer has
 * drained, capped at the window). This stream owns only the port + controller:
 * it posts the byte counts the primitive computes and enqueues arriving chunks.
 * A slow consumer that stops pulling stops replenishing, the writer exhausts its
 * credit, and `desiredSize` goes ≤ 0 — genuine back-pressure.
 */
export function portToReadable(port: MessagePort): ReadableStream<Uint8Array> {
  port.start?.();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const flow = new PipeReader();

  function grant(bytes: number): void {
    if (bytes <= 0) return;
    const credit: PipeMessage = { type: 'credit', bytes };
    port.postMessage(credit);
  }

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      port.onmessage = (e: MessageEvent) => {
        const msg = e.data as unknown;
        if (!isPipeMessage(msg)) return;
        if (msg.type === 'data') {
          flow.recordArrival(msg.chunk.byteLength);
          controller!.enqueue(msg.chunk);
        } else if (msg.type === 'end') {
          controller!.close();
          port.close();
        } else if (msg.type === 'error') {
          controller!.error(new Error(msg.code));
          port.close();
        }
      };
    },
    pull() {
      // First demand opens the window (grants it whole); subsequent demands
      // replenish only the drained bytes, capped at the window.
      grant(flow.open() || flow.replenish());
    },
    cancel() {
      const msg: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(msg);
      port.close();
    },
  });
}
