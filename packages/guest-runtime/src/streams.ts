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
  // Writer starts at 0 credit; the reader grants credit via PipeCredit messages.
  let credit = 0;
  // Queue of waiters: each waiter blocks until enough credit is available or the
  // pipe is broken. On EPIPE/end the reject path wakes them all immediately.
  const creditWaiters: Array<{ needed: number; resolve: () => void; reject: (e: unknown) => void }> = [];

  // STICKY broken flag (Seam 2). Set the instant an `end`/`error` arrives (the
  // reader cancelled / the consumer died). Once broken, EVERY write rejects
  // IMMEDIATELY rather than parking on credit. This is essential for an unbounded
  // producer (e.g. `yes | head -n3`): without it, a producer whose current write
  // does NOT park (credit still available) keeps `postMessage`-ing to a closed
  // peer (silently dropped) and never observes the EPIPE, OR a producer that
  // parks on credit AFTER the EPIPE was posted waits forever for credit that
  // will never come. `rejectAllWaiters` alone only helps writers ALREADY parked
  // at the instant the EPIPE lands — the sticky flag closes both races.
  let broken: { code: string } | undefined;

  /** The broken-pipe error to reject writes with, built from the sticky flag. */
  function brokenError(): Error & { code: string } {
    const code = broken?.code ?? 'EPIPE';
    return Object.assign(new Error(code), { code });
  }

  /** Wake all parked writers with an error (reader cancelled / pipe closed). */
  function rejectAllWaiters(err: unknown): void {
    const waiters = creditWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (!isPipeMessage(msg)) return;
    if (msg.type === 'credit') {
      credit += msg.bytes;
      // Wake waiters whose needed credit is now satisfied, in FIFO order.
      while (creditWaiters.length > 0 && credit >= creditWaiters[0].needed) {
        const waiter = creditWaiters.shift()!;
        waiter.resolve();
      }
    } else if (msg.type === 'end' || msg.type === 'error') {
      // Reader cancelled or peer sent EPIPE. Latch the STICKY broken flag so every
      // subsequent write rejects at once, and wake all parked writers now so they
      // don't hang forever waiting for credit that will never arrive.
      const code = msg.type === 'error' ? msg.code : 'EPIPE';
      broken = { code };
      rejectAllWaiters(brokenError());
    }
  };

  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return broken ? Promise.reject(brokenError()) : Promise.resolve();
    const chunks = buf;
    buf = [];
    bufSize = 0;

    return (async () => {
      for (const chunk of chunks) {
        // Sticky broken: the consumer is gone — reject without parking or posting.
        if (broken) throw brokenError();
        // Block until the reader has granted enough credit for this chunk.
        // If the reader cancels or sends EPIPE, the promise rejects immediately
        // (the waiter is woken with the broken-pipe error).
        if (credit < chunk.byteLength) {
          await new Promise<void>((resolve, reject) => {
            creditWaiters.push({ needed: chunk.byteLength, resolve, reject });
          });
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
      // Sticky broken: reject IMMEDIATELY (do not buffer, park, or arm a timer).
      // This is the top-of-write guard that stops an unbounded producer the
      // moment the downstream has gone away.
      if (broken) return Promise.reject(brokenError());
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
 * Flow control is a sliding credit window of {@link INITIAL_CREDIT_BYTES}. The
 * reader grants the writer permission to send at most `window` bytes ahead of
 * what the consumer has actually drained:
 *
 *   - On the first `pull()` the reader opens the window: grants `window` bytes.
 *   - Each arriving `data` chunk consumes outstanding credit (`granted` rises by
 *     the chunk size as it lands; really it was pre-granted, so we track it as
 *     "in flight").
 *   - Every subsequent `pull()` (the stream asks for more because the consumer
 *     drained a chunk) replenishes ONLY the bytes the consumer has consumed
 *     since the last grant — never a fresh flat window. So a SLOW consumer that
 *     stops pulling stops replenishing, the writer exhausts its credit, and its
 *     `desiredSize` goes ≤0 — genuine backpressure.
 *
 * This replaces the previous (broken) behavior where every `pull()` posted a
 * flat `INITIAL_CREDIT_BYTES`, letting a fast writer to a slow reader grant
 * unbounded credit and never block.
 */
export function portToReadable(port: MessagePort): ReadableStream<Uint8Array> {
  port.start?.();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const window = INITIAL_CREDIT_BYTES;
  // Credit currently granted to the writer but not yet consumed by the consumer.
  let outstanding = 0;
  // Bytes that arrived and the consumer has pulled (drained) but we have not yet
  // credited back to the writer. Accumulated across pulls; flushed as a grant.
  let consumedUncredited = 0;
  let opened = false;

  function grant(bytes: number): void {
    if (bytes <= 0) return;
    outstanding += bytes;
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
          // This chunk used up part of the granted window.
          outstanding -= msg.chunk.byteLength;
          consumedUncredited += msg.chunk.byteLength;
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
      if (!opened) {
        // First demand: open the window. Nothing consumed yet, so just grant it.
        opened = true;
        consumedUncredited = 0;
        grant(window);
        return;
      }
      // Replenish only what the consumer has actually drained since the last
      // grant, capped so total outstanding never exceeds the window. A slow
      // consumer (no pulls) grants nothing → writer blocks.
      const room = window - outstanding;
      const replenish = Math.min(consumedUncredited, room);
      consumedUncredited -= replenish;
      grant(replenish);
    },
    cancel() {
      const msg: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(msg);
      port.close();
    },
  });
}
