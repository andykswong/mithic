import {
  isPipeMessage,
  INITIAL_CREDIT_BYTES,
  PIPE_FLUSH_BYTES,
  PIPE_FLUSH_MS,
  TRANSFER_THRESHOLD_BYTES,
} from '@mithic/protocol';
import type { PipeMessage } from '@mithic/protocol';

/**
 * Wraps a MessagePort (writable side) as a WritableStream<Uint8Array>.
 * Implements credit-based flow control: waits for credit before flushing.
 */
export function portToWritable(port: MessagePort): WritableStream<Uint8Array> {
  port.start?.();
  let credit = 0;
  let creditResolve: (() => void) | null = null;

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (isPipeMessage(msg) && msg.type === 'credit') {
      credit += msg.bytes;
      if (creditResolve) {
        const r = creditResolve;
        creditResolve = null;
        r();
      }
    }
  };

  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return Promise.resolve();
    const chunks = buf;
    buf = [];
    bufSize = 0;

    return (async () => {
      for (const chunk of chunks) {
        // Wait for credit
        while (credit < chunk.byteLength) {
          await new Promise<void>(resolve => { creditResolve = resolve; });
        }
        credit -= chunk.byteLength;
        const msg: PipeMessage = { type: 'data', chunk };
        const transfer = chunk.byteLength >= TRANSFER_THRESHOLD_BYTES ? [chunk.buffer as ArrayBuffer] : [];
        port.postMessage(msg, transfer);
      }
    })();
  }

  return new WritableStream<Uint8Array>({
    write(chunk) {
      buf.push(chunk);
      bufSize += chunk.byteLength;
      if (bufSize >= PIPE_FLUSH_BYTES) return flushNow();
      if (flushTimer === null) {
        return new Promise<void>(resolve => {
          flushTimer = setTimeout(() => { flushNow().then(resolve); }, PIPE_FLUSH_MS);
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
 * Sends credit to the writable side automatically.
 */
export function portToReadable(port: MessagePort): ReadableStream<Uint8Array> {
  port.start?.();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      port.onmessage = (e: MessageEvent) => {
        const msg = e.data as unknown;
        if (!isPipeMessage(msg)) return;
        if (msg.type === 'data') {
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
      // Send initial credit to unblock the writable side
      const credit: PipeMessage = { type: 'credit', bytes: INITIAL_CREDIT_BYTES };
      port.postMessage(credit);
    },
    cancel() {
      const msg: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(msg);
      port.close();
    },
  });
}
