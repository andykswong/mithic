import { expect, test } from 'vitest';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import { portToReadable, portToWritable } from './streams.ts';

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
