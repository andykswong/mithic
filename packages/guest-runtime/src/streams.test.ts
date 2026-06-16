import { expect, test } from 'vitest';
import { portToReadable, portToWritable } from './streams.ts';

test('portToWritable + portToReadable round-trip small chunk', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portToWritable(port1);
  const readable = portToReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  const data = new Uint8Array([1, 2, 3, 4]);
  await writer.write(data);
  await writer.close();

  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    chunks.push(r.value);
  }

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
