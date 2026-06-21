/**
 * Group K.2 — pipe backpressure and broken-pipe (EPIPE) path, browser-native.
 *
 * These tests exercise the REAL, shipped @mithic/guest-runtime portToReadable /
 * portToWritable helpers directly in the Chromium browser environment. Running in
 * the browser (rather than Node) validates:
 *
 *   - Real Chromium MessageChannel / ArrayBuffer transfer semantics (ownership
 *     moves — not copied — when byteLength ≥ TRANSFER_THRESHOLD_BYTES).
 *   - Browser-native ReadableStream / WritableStream back-pressure mechanics
 *     (desiredSize, ready, pull-based credit replenishment).
 *   - The sticky-broken EPIPE flag: once the reader cancels, a subsequent write
 *     that does NOT park (credit still available) must still reject immediately.
 *     This is the race that hung `yes | head -n3` on the inlined-code path and
 *     that a stale inlined copy — lacking the sticky flag — would not catch.
 *
 * There is no inlined copy of portToWritable / portToReadable here. Every test
 * calls the real exports from @mithic/guest-runtime/streams.
 *
 * Kernel-level (IframeRuntime) coverage lives in kernel-iframe.browser.test.ts;
 * the full pipeline e2e lives in pipe-e2e.test.ts.
 */
import { expect, test } from 'vitest';
import { portToReadable, portToWritable } from '@mithic/guest-runtime/streams';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';

// ---------------------------------------------------------------------------
// Test 1: backpressure — credit-gated writes block until the reader pulls
// ---------------------------------------------------------------------------

test(
  'backpressure: 1 MB producer → slow consumer exhausts credit (desiredSize ≤ 0)',
  async () => {
    const { port1, port2 } = new MessageChannel();
    const writable = portToWritable(port1);
    const readable = portToReadable(port2);

    const TOTAL = 1024 * 1024;  // 1 MB
    const CHUNK = INITIAL_CREDIT_BYTES; // 64 KB chunks

    const writer = writable.getWriter();
    const reader = readable.getReader();

    let minDesiredSize = Infinity;
    let sawBackpressure = false;
    let received = 0;

    const producer = (async () => {
      const n = TOTAL / CHUNK;
      for (let i = 0; i < n; i++) {
        const ds = writer.desiredSize ?? 0;
        if (ds < minDesiredSize) minDesiredSize = ds;
        if (ds <= 0 && received < TOTAL) sawBackpressure = true;
        // Do NOT await each write so we can observe desiredSize going negative
        // while the slow consumer has not yet drained the queued credit window.
        void writer.write(new Uint8Array(CHUNK));
        const ds2 = writer.desiredSize ?? 0;
        if (ds2 < minDesiredSize) minDesiredSize = ds2;
        if (ds2 <= 0 && received < TOTAL) sawBackpressure = true;
        await writer.ready;
      }
      await writer.close();
    })();

    const consumer = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        // Slow drain: pause between chunks so the writer exhausts its credit window.
        await new Promise<void>((r) => setTimeout(r, 2));
      }
    })();

    await Promise.all([producer, consumer]);

    expect(received).toBe(TOTAL);
    // The credit window is finite: a fast producer to a slow consumer MUST stall.
    expect(sawBackpressure).toBe(true);
    expect(minDesiredSize).toBeLessThanOrEqual(0);

    port1.close();
    port2.close();
  },
  30_000,
);

// ---------------------------------------------------------------------------
// Test 2: broken-pipe — peer sends EPIPE while writer is parked on credit
// ---------------------------------------------------------------------------

test('broken-pipe: peer EPIPE unblocks a parked writer', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);

  const writer = writable.getWriter();
  // Absorb the stream-level error that fires when the stream errors (expected).
  writer.closed.catch(() => { /* expected — stream errors on EPIPE */ });

  // No portToReadable is created: port2 is the "peer" side. We manually control
  // credit. The writer starts with zero credit, so a write that exceeds
  // PIPE_FLUSH_BYTES will call flushNow() which parks in creditWaiters.
  port2.start();

  // Write a chunk large enough to trigger immediate flushNow (> PIPE_FLUSH_BYTES)
  // with no credit — it will park.
  const { PIPE_FLUSH_BYTES } = await import('@mithic/protocol');
  const chunk = new Uint8Array(PIPE_FLUSH_BYTES + 1);
  const writePromise = writer.write(chunk);

  // Give the write a tick to enqueue and park.
  await new Promise<void>((r) => setTimeout(r, 10));

  // Peer sends EPIPE — the parked writer must wake and reject.
  port2.postMessage({ type: 'error', code: 'EPIPE' });

  // The parked write must settle with EPIPE, not hang.
  await expect(writePromise).rejects.toThrow('EPIPE');

  port1.close();
  port2.close();
});

// ---------------------------------------------------------------------------
// Test 3: sticky broken flag — a write AFTER the EPIPE arrived (NOT parked)
//         must still reject immediately (Seam 2 regression).
// ---------------------------------------------------------------------------

test(
  'sticky broken: write AFTER reader-cancel rejects immediately (Seam 2 regression)',
  async () => {
    const { port1, port2 } = new MessageChannel();
    const writable = portToWritable(port1);
    const readable = portToReadable(port2);

    const writer = writable.getWriter();
    writer.closed.catch(() => { /* expected */ });

    // Grant generous credit so subsequent writes do NOT park.
    // Then cancel the reader — which posts EPIPE to the writer's port.
    const reader = readable.getReader();
    // The credit is implicit via the sliding window opened on first pull;
    // we open the reader, let it grant credit via pull, then cancel.
    // Do a tiny read to trigger pull() and open the credit window.
    const firstRead = reader.read(); // triggers pull → posts INITIAL_CREDIT_BYTES credit

    // Let the credit grant message propagate.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Cancel the reader — posts EPIPE to the writer's port.
    await reader.cancel();

    // Let the EPIPE message propagate and latch the sticky broken flag.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Abort firstRead (the readable closed via cancel, so it should have settled).
    await firstRead.catch(() => { /* ignore */ });

    // A write that would NOT park (credit was granted) must still reject immediately.
    await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow('EPIPE');
    // Sticky: a second write also rejects at once.
    await expect(writer.write(new Uint8Array([4]))).rejects.toThrow('EPIPE');

    port1.close();
    port2.close();
  },
);

// ---------------------------------------------------------------------------
// Test 4: ArrayBuffer transfer in Chromium — large chunks transfer ownership
// ---------------------------------------------------------------------------

test('ArrayBuffer is transferred (not copied) for large chunks', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const readable = portToReadable(port2);

  // Use a chunk large enough to trigger the transfer path
  // (TRANSFER_THRESHOLD_BYTES = 10 KB).
  const size = 64 * 1024;
  const original = new Uint8Array(size);
  for (let i = 0; i < size; i++) original[i] = i & 0xff;

  const writer = writable.getWriter();
  const reader = readable.getReader();

  const sendBuf = original.slice(); // copy so we can check the source after transfer
  const [, result] = await Promise.all([
    writer.write(sendBuf).then(() => writer.close()),
    (async () => {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return chunks;
    })(),
  ]);

  const received = new Uint8Array(result.reduce((a, c) => a + c.byteLength, 0));
  let offset = 0;
  for (const c of result) { received.set(c, offset); offset += c.byteLength; }

  // All bytes must arrive intact.
  expect(received).toEqual(original);

  // In a real browser, the ArrayBuffer was transferred: the source view is now
  // detached (byteLength === 0). This confirms zero-copy transfer semantics.
  expect(sendBuf.byteLength).toBe(0);

  port1.close();
  port2.close();
});
