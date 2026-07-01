import { expect, test } from 'vitest';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import { portToReadable, portToWritable, pumpStreamToPort } from './streams.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('portToWritable + portToReadable round-trip small chunk', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const readable = portToReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  const data = new Uint8Array([1, 2, 3, 4]);

  // Start writing and reading concurrently: the reader's pull() grants credit
  // which unblocks the writer. Both sides must run in parallel.
  const [, chunks] = await Promise.all([
    writer.write(data).then(() => writer.close()),
    (async () => {
      const acc: Uint8Array[] = [];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        acc.push(r.value);
      }
      return acc;
    })(),
  ]);

  const received = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { received.set(c, offset); offset += c.byteLength; }

  expect(received).toEqual(data);
});

test('portToWritable sends EPIPE on abort', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const readable = portToReadable(port2);

  const writer = writable.getWriter();
  await writer.abort();

  const reader = readable.getReader();
  await expect(reader.read()).rejects.toThrow('EPIPE');
});

test('writer blocks when no credit and resumes when PipeCredit arrives', async () => {
  const { port1, port2 } = new MessageChannel();
  // Create writable but do NOT create a readable (no automatic credit grant).
  const writable = portToWritable(port1);
  const writer = writable.getWriter();

  // Write a chunk — writer starts with 0 credit so this should stay pending.
  const chunk = new Uint8Array(8);
  let resolved = false;
  const writePromise = writer.write(chunk).then(() => { resolved = true; });

  // After a tick, the write should still be pending (no credit granted yet).
  await new Promise(r => setTimeout(r, 20));
  expect(resolved).toBe(false);

  // Now manually post a PipeCredit message from the peer side.
  port2.postMessage({ type: 'credit', bytes: INITIAL_CREDIT_BYTES });

  // Collect the data message that will be sent once credit is granted.
  const received = await new Promise<unknown>(resolve => {
    port2.onmessage = (e) => resolve(e.data);
    port2.start?.();
  });

  await writePromise;
  expect(resolved).toBe(true);
  expect((received as { type: string }).type).toBe('data');

  port1.close();
  port2.close();
});

test('writer blocks exhausted credit mid-stream and resumes on replenishment', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const writer = writable.getWriter();

  // Grant just enough credit for a first chunk (4 bytes) to establish flow.
  port2.start?.();
  port2.postMessage({ type: 'credit', bytes: 4 });

  // Collect messages from port2 side.
  const messages: unknown[] = [];
  port2.onmessage = (e) => messages.push(e.data);

  await new Promise(r => setTimeout(r, 0)); // let credit arrive
  // Small write — will be queued and flushed. With credit=4, will succeed.
  const bigChunk = new Uint8Array(INITIAL_CREDIT_BYTES + 1); // exceeds any credit
  let bigResolved = false;
  const bigWrite = writer.write(bigChunk).then(() => { bigResolved = true; });

  // After a tick, big write should still be pending.
  await new Promise(r => setTimeout(r, 30));
  expect(bigResolved).toBe(false);

  // Grant sufficient credit to unblock.
  port2.postMessage({ type: 'credit', bytes: INITIAL_CREDIT_BYTES + 1 });
  await bigWrite;
  expect(bigResolved).toBe(true);

  // Clean up: send 'end' or just close.
  await writer.close();
  port1.close();
  port2.close();
});

test('backpressure: fast writer to a SLOW reader exhausts credit (desiredSize ≤ 0)', async () => {
  // 1MB through a 64KB-window pipe to a consumer that reads slowly. The writer's
  // desiredSize must go ≤ 0 (credit exhausted) well before all bytes are drained,
  // and every byte must still arrive.
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const readable = portToReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  const total = 1024 * 1024;
  const chunkSize = 64 * 1024;
  const chunks = total / chunkSize;

  let minDesiredSize = Infinity;
  let received = 0;
  let sawBackpressure = false;

  const producer = (async () => {
    for (let i = 0; i < chunks; i++) {
      // Apply backpressure: await readiness, but sample desiredSize first so we
      // can observe it dropping ≤ 0 while a prior write is still in flight to the
      // slow reader.
      const ds = writer.desiredSize ?? 0;
      if (ds < minDesiredSize) minDesiredSize = ds;
      if (ds <= 0 && received < total) sawBackpressure = true;
      // Do NOT await each write: let writes queue so desiredSize can go negative
      // as the underlying credit-gated sink stalls. Honor `ready` for backpressure.
      void writer.write(new Uint8Array(chunkSize));
      const ds2 = writer.desiredSize ?? 0;
      if (ds2 < minDesiredSize) minDesiredSize = ds2;
      if (ds2 <= 0 && received < total) sawBackpressure = true;
      await writer.ready;
    }
    await writer.close();
  })();

  const consumer = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      await delay(2); // slow drain
    }
  })();

  await Promise.all([producer, consumer]);

  expect(received).toBe(total);
  // The writer must have hit backpressure: at some point desiredSize ≤ 0 while
  // the consumer had not yet drained everything.
  expect(minDesiredSize).toBeLessThanOrEqual(0);
  expect(sawBackpressure).toBe(true);

  port1.close();
  port2.close();
}, 20000);

// Fix 1 regression: parked writer wakes (rejects) when reader sends EPIPE
test('Fix 1: parked writer rejects immediately when reader sends EPIPE', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const writer = writable.getWriter();
  port2.start?.();

  // Write a large chunk — chunk size > 0 credit, so flush parks in creditWaiters.
  // Use a size that triggers the PIPE_FLUSH_BYTES path (immediate flushNow call).
  const { PIPE_FLUSH_BYTES } = await import('@mithic/protocol');
  const chunk = new Uint8Array(PIPE_FLUSH_BYTES);
  const writePromise = writer.write(chunk);
  // Absorb the writer.closed rejection that fires when the stream errors.
  writer.closed.catch(() => { /* stream errored — expected */ });

  // After a tick, write is still pending (no credit granted).
  await new Promise(r => setTimeout(r, 10));

  // Peer sends EPIPE — parked writer must wake and reject.
  port2.postMessage({ type: 'error', code: 'EPIPE' });

  // Must settle within a reasonable time, not hang forever.
  await expect(writePromise).rejects.toThrow('EPIPE');

  port1.close();
  port2.close();
});

// Fix 1 regression: parked writer wakes (rejects) when reader sends end
test('Fix 1: parked writer rejects immediately when reader sends end', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const writer = writable.getWriter();
  port2.start?.();

  const { PIPE_FLUSH_BYTES } = await import('@mithic/protocol');
  const chunk = new Uint8Array(PIPE_FLUSH_BYTES);
  const writePromise = writer.write(chunk);
  // Absorb the writer.closed rejection that fires when the stream errors.
  writer.closed.catch(() => { /* stream errored — expected */ });

  await new Promise(r => setTimeout(r, 10));

  // Peer closes/ends — parked writer must wake and reject with EPIPE.
  port2.postMessage({ type: 'end' });

  await expect(writePromise).rejects.toThrow('EPIPE');

  port1.close();
  port2.close();
});

// Seam 2 regression: STICKY broken flag — a write issued AFTER the EPIPE landed
// (while NOT parked) must reject IMMEDIATELY, not park forever. This is the race
// that hung `yes | head -n3` (an unbounded producer whose write does not park).
test('Seam 2: a write AFTER the peer EPIPE rejects immediately (sticky broken)', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const writer = writable.getWriter();
  port2.start?.();
  writer.closed.catch(() => { /* stream errors once broken — expected */ });

  // Grant generous credit so writes do NOT park, then let the peer post EPIPE
  // while the writer is idle (no parked waiter to wake).
  port2.postMessage({ type: 'credit', bytes: 1 << 20 });
  port2.postMessage({ type: 'error', code: 'EPIPE' });
  await new Promise(r => setTimeout(r, 10)); // let the error onmessage latch `broken`

  // A small write (well under credit, would NOT park) must still reject at once.
  await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow('EPIPE');
  // And a subsequent write also rejects immediately (sticky — stays broken).
  await expect(writer.write(new Uint8Array([4]))).rejects.toThrow('EPIPE');

  port1.close();
  port2.close();
});

// Seam 2: an `end` from the peer is equally sticky for later writes.
test('Seam 2: a write AFTER the peer end rejects immediately (sticky broken)', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const writer = writable.getWriter();
  port2.start?.();
  writer.closed.catch(() => { /* expected */ });

  port2.postMessage({ type: 'credit', bytes: 1 << 20 });
  port2.postMessage({ type: 'end' });
  await new Promise(r => setTimeout(r, 10));

  await expect(writer.write(new Uint8Array([1]))).rejects.toThrow('EPIPE');

  port1.close();
  port2.close();
});

// ── pumpStreamToPort (the throughput-preserving stream→port bridge) ───────────

test('pumpStreamToPort: a high-rate small-chunk source flows FAST (no per-chunk flush-timer throttle)', async () => {
  // 100k tiny chunks: a `source.pipeTo(portToWritable(port))` would throttle to
  // ~one chunk per PIPE_FLUSH_MS tick (~400 s). pumpStreamToPort posts each
  // credit-permitting chunk immediately, so this completes in well under 1 s.
  const { port1: wr, port2: rd } = new MessageChannel();
  const N = 100_000;
  let produced = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (produced >= N) { ctrl.close(); return; }
      produced++;
      ctrl.enqueue(new Uint8Array([65])); // one byte per chunk
    },
  });
  const reader = portToReadable(rd).getReader();
  let bytes = 0;
  const consume = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value!.byteLength; } })();
  const started = Date.now();
  await Promise.all([pumpStreamToPort(source, wr), consume]);
  const elapsed = Date.now() - started;
  expect(bytes).toBe(N);
  expect(elapsed).toBeLessThan(5000); // would be hundreds of seconds under pipeTo(portToWritable)
});

test('pumpStreamToPort: forwards multi-chunk data byte-exact then EOFs the reader', async () => {
  const { port1: wr, port2: rd } = new MessageChannel();
  const parts = [new Uint8Array([0, 255, 254]), new Uint8Array([65, 66]), new Uint8Array([0])];
  let i = 0;
  const source = new ReadableStream<Uint8Array>({ pull(ctrl) { if (i >= parts.length) { ctrl.close(); return; } ctrl.enqueue(parts[i++]); } });
  const reader = portToReadable(rd).getReader();
  const acc: number[] = [];
  const consume = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; acc.push(...value!); } })();
  await Promise.all([pumpStreamToPort(source, wr), consume]);
  expect(acc).toEqual([0, 255, 254, 65, 66, 0]);
});

test('pumpStreamToPort: a reader that cancels early (EPIPE) ends the pump and cancels the source', async () => {
  const { port1: wr, port2: rd } = new MessageChannel();
  let produced = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(ctrl) { produced++; ctrl.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  });
  const readable = portToReadable(rd);
  const reader = readable.getReader();
  // Start the pump CONCURRENTLY with the reader — read a chunk (grants credit +
  // opens flow), then cancel to post EPIPE up the port. The parked/next reserve
  // in the pump must reject, ending it and cancelling the (unbounded) source.
  const pump = pumpStreamToPort(source, wr);
  await reader.read();
  await reader.cancel();
  await pump; // resolves (does not hang / throw)
  expect(cancelled).toBe(true);
  // The pump stopped rather than draining the unbounded source forever.
  expect(produced).toBeLessThan(1_000_000);
}, 10000);

test('pumpStreamToPort: an empty source just EOFs the reader (0 bytes)', async () => {
  const { port1: wr, port2: rd } = new MessageChannel();
  const source = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.close(); } });
  const reader = portToReadable(rd).getReader();
  let bytes = 0;
  let ended = false;
  const consume = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) { ended = true; break; } bytes += value!.byteLength; } })();
  await Promise.all([pumpStreamToPort(source, wr), consume]);
  expect(bytes).toBe(0);
  expect(ended).toBe(true);
});

test('pumpStreamToPort: a chunk larger than the credit window still flows (sub-window split)', async () => {
  const { port1: wr, port2: rd } = new MessageChannel();
  const big = new Uint8Array(INITIAL_CREDIT_BYTES * 2 + 123); // > one window
  big.fill(7);
  let sent = false;
  const source = new ReadableStream<Uint8Array>({ pull(ctrl) { if (sent) { ctrl.close(); return; } sent = true; ctrl.enqueue(big); } });
  const reader = portToReadable(rd).getReader();
  let bytes = 0;
  const consume = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value!.byteLength; } })();
  await Promise.all([pumpStreamToPort(source, wr), consume]);
  expect(bytes).toBe(big.byteLength);
});
