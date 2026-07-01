import {
  isPipeMessage,
  INITIAL_CREDIT_BYTES,
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
 * B5: wrap a single bidirectional MessagePort (an `ipc/connect`/`ipc/accept`
 * connection end) as a `{ readable, writable }` duplex.
 *
 * The peer holds the other end of the SAME channel and is expected to call this
 * too, so both directions speak the one canonical PipeMessage flow-control
 * protocol over the single port. Inbound `data` feeds the readable (and we post
 * `credit` back); inbound `credit`/`end`/`error` drive the writable side. A
 * single `onmessage` router demultiplexes the two directions — `data` is
 * always peer→us, `credit` is always the peer crediting OUR writes.
 */
export function portToDuplex(port: MessagePort): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  port.start?.();
  const reader = new PipeReader();
  const writer = new PipeWriter();
  let rctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let readClosed = false;

  function grant(bytes: number): void {
    if (bytes <= 0) return;
    const credit: PipeMessage = { type: 'credit', bytes };
    port.postMessage(credit);
  }

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as unknown;
    if (!isPipeMessage(msg)) return;
    if (msg.type === 'data') {
      reader.recordArrival(msg.chunk.byteLength);
      rctrl?.enqueue(msg.chunk);
    } else if (msg.type === 'credit') {
      writer.addCredit(msg.bytes);
    } else if (msg.type === 'end') {
      if (!readClosed) { readClosed = true; rctrl?.close(); }
    } else if (msg.type === 'error') {
      writer.markBroken(msg.code);
      if (!readClosed) { readClosed = true; rctrl?.error(new Error(msg.code)); }
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) { rctrl = ctrl; },
    pull() { grant(reader.open() || reader.replenish()); },
    cancel() {
      // We no longer read; tell the peer to stop writing toward us.
      const m: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(m);
    },
  });

  let buf: Uint8Array[] = [];
  let bufSize = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow(): Promise<void> {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return writer.broken ? Promise.reject(writer.brokenError()) : Promise.resolve();
    const chunks = buf;
    buf = [];
    bufSize = 0;
    return (async () => {
      for (const chunk of chunks) {
        await writer.reserve(chunk.byteLength);
        const m: PipeMessage = { type: 'data', chunk };
        const transfer = chunk.byteLength >= TRANSFER_THRESHOLD_BYTES ? [chunk.buffer as ArrayBuffer] : [];
        port.postMessage(m, transfer);
      }
    })();
  }

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (writer.broken) return Promise.reject(writer.brokenError());
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
        const m: PipeMessage = { type: 'end' };
        port.postMessage(m);
      });
    },
    abort() {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      const m: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(m);
    },
  });

  return { readable, writable };
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
export function portToReadable(port: MessagePort, signal?: AbortSignal): ReadableStream<Uint8Array> {
  port.start?.();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const flow = new PipeReader();

  function grant(bytes: number): void {
    if (bytes <= 0) return;
    const credit: PipeMessage = { type: 'credit', bytes };
    port.postMessage(credit);
  }

  /** Tear down: post EPIPE up the port (so the peer writer stops) and close. */
  function teardown(): void {
    if (closed) return;
    closed = true;
    try {
      const msg: PipeMessage = { type: 'error', code: 'EPIPE' };
      port.postMessage(msg);
      port.close();
    } catch { /* port already neutered/closed */ }
  }

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      port.onmessage = (e: MessageEvent) => {
        const msg = e.data as unknown;
        if (!isPipeMessage(msg)) return;
        // Once the stream is torn down (cancelled / ended / errored) a late
        // `data` message can still be dispatched before the port neuters —
        // enqueuing on a closed controller throws, so drop it.
        if (closed) return;
        if (msg.type === 'data') {
          flow.recordArrival(msg.chunk.byteLength);
          controller!.enqueue(msg.chunk);
        } else if (msg.type === 'end') {
          closed = true; controller!.close(); port.close();
        } else if (msg.type === 'error') {
          closed = true; controller!.error(new Error(msg.code)); port.close();
        }
      };
      // B6: an external AbortSignal (e.g. fetch's `init.signal`) tears the stream
      // down even while a consumer holds a reader lock — it errors the controller
      // (unblocking a pending read) AND posts EPIPE up the port so the peer writer
      // (the kernel net/fetch pump) aborts the in-flight transport.
      if (signal) {
        const onAbort = (): void => {
          if (closed) return;
          teardown();
          try { controller!.error(abortReason(signal)); } catch { /* already closed */ }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    pull() {
      // First demand opens the window (grants it whole); subsequent demands
      // replenish only the drained bytes, capped at the window.
      grant(flow.open() || flow.replenish());
    },
    cancel() {
      teardown();
    },
  });
}

/**
 * Drive a guest-realm `ReadableStream<Uint8Array>` INTO a pipe WRITE port,
 * honoring the credit protocol, then send EOF + close. This is the guest-side
 * twin of the kernel's `pumpToPort`: use it to feed a shell-realm stream (e.g. a
 * compound-pipeline stage's inter-stage `TransformStream.readable`) into a
 * kernel pipe whose READ end was injected as a child's fd (dup2).
 *
 * WHY NOT `source.pipeTo(portToWritable(port))`: `portToWritable` COALESCES
 * sub-{@link PIPE_FLUSH_BYTES} writes behind a {@link PIPE_FLUSH_MS} timer, and
 * `pipeTo` (HWM 1) awaits each write's readiness — so a high-rate small-chunk
 * producer (e.g. `seq` emitting one short line per chunk) is throttled to ~one
 * chunk per flush tick (~4 ms), i.e. hundreds of seconds for 100k lines — a de
 * facto hang. This pump posts each (sub-window) chunk the instant credit allows,
 * with NO flush timer, so throughput is bounded only by the reader's credit
 * window — genuine back-pressure without the per-chunk latency tax.
 *
 * Back-pressure + EPIPE: `reserve()` parks until the reader (the child draining
 * its fd) grants credit and rejects promptly once the pipe breaks (child closed
 * its fd early / EPIPE), which ends the pump and cancels `source` so an upstream
 * producer stops. A source chunk larger than `windowBytes` is split so a
 * >window chunk never parks forever on a window that can't grant it (R2).
 * Fire-and-forget friendly: it never throws (source/transfer errors just end the
 * pump); the port is always closed.
 */
export async function pumpStreamToPort(
  source: ReadableStream<Uint8Array>,
  port: MessagePort,
  windowBytes: number = INITIAL_CREDIT_BYTES,
): Promise<void> {
  port.start?.();
  const flow = new PipeWriter();
  port.onmessage = (e: MessageEvent): void => {
    const msg = e.data as unknown;
    if (!isPipeMessage(msg)) return;
    if (msg.type === 'credit') flow.addCredit(msg.bytes);
    else if (msg.type === 'end' || msg.type === 'error') flow.markBroken(msg.type === 'error' ? msg.code : 'EPIPE');
  };
  const reader = source.getReader();
  let broke = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      for (let off = 0; off < value.byteLength; off += windowBytes) {
        const slice = value.subarray(off, off + windowBytes);
        const chunk = slice.byteOffset === 0 && slice.byteLength === slice.buffer.byteLength ? slice : new Uint8Array(slice);
        await flow.reserve(chunk.byteLength); // rejects promptly if the pipe broke (EPIPE)
        const msg: PipeMessage = { type: 'data', chunk };
        const transfer = chunk.byteLength >= TRANSFER_THRESHOLD_BYTES ? [chunk.buffer as ArrayBuffer] : [];
        port.postMessage(msg, transfer);
      }
    }
  } catch {
    broke = true; // broken pipe (EPIPE) or a source read error — stop pumping.
  } finally {
    // Release the source: on a broken pipe cancel it (propagate EPIPE upstream);
    // on clean EOF just release the lock.
    if (broke) { try { await reader.cancel(); } catch { /* already closed */ } }
    else reader.releaseLock();
  }
  try { port.postMessage({ type: 'end' } satisfies PipeMessage); } catch { /* closed */ }
  try { port.close(); } catch { /* closed */ }
}

/** The abort reason to error a stream with (an Error, preferring the signal's own). */
function abortReason(signal: AbortSignal): unknown {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}
