import { expect, test, describe } from 'vitest';
import { sinkToStream, toSink, type OutputSink } from './output-sink.ts';

describe('toSink', () => {
  test('wraps a bare (s) => void so it is still callable as text', () => {
    let acc = '';
    const sink = toSink((s) => { acc += s; });
    sink('hello');
    expect(acc).toBe('hello');
  });

  test('bare-callback writeBytes falls back to UTF-8 decode', () => {
    let acc = '';
    const sink = toSink((s) => { acc += s; });
    sink.writeBytes(new TextEncoder().encode('abc'));
    expect(acc).toBe('abc');
  });

  test('an existing OutputSink is returned unchanged (writeBytes stays raw)', () => {
    const chunks: Uint8Array[] = [];
    let text = '';
    const real: OutputSink = Object.assign((s: string) => { text += s; }, {
      writeBytes: (b: Uint8Array) => { chunks.push(b); },
    });
    const sink = toSink(real);
    expect(sink).toBe(real);
    sink.writeBytes(new Uint8Array([0, 255]));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0])).toEqual([0, 255]);
    expect(text).toBe('');
  });

  test('bare-callback writeBytes reassembles a multi-byte char split across chunks', () => {
    let acc = '';
    const sink = toSink((s) => { acc += s; });
    // '€' is UTF-8 0xE2 0x82 0xAC — split it across two writeBytes calls. A
    // non-streaming per-chunk decode would emit replacement chars; the streaming
    // decoder must buffer the partial char and reassemble it.
    sink.writeBytes(new Uint8Array([0xe2, 0x82]));
    sink.writeBytes(new Uint8Array([0xac]));
    expect(acc).toBe('€');
  });
});

test('process.ts-style sink writeBytes writes raw bytes to the guest writer', async () => {
  const written: Uint8Array[] = [];
  const fakeWriter = { write: (b: Uint8Array) => { written.push(b.slice()); return Promise.resolve(); } };
  const encoder = new TextEncoder();
  const onStdout = Object.assign(
    (s: string) => { void fakeWriter.write(encoder.encode(s)); },
    { writeBytes: (b: Uint8Array) => { void fakeWriter.write(b); } },
  );
  onStdout.writeBytes(new Uint8Array([0, 255, 254]));
  expect(Array.from(written[0])).toEqual([0, 255, 254]);
});

test('sinkToStream writes text (UTF-8) and raw bytes into the stream, in order', async () => {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const { sink, close } = sinkToStream(ts.writable);
  // Drain concurrently: a TransformStream applies backpressure (readable HWM 0),
  // so a queued write only settles once the reader pulls — reading after close()
  // would deadlock. This mirrors real pipeline usage (downstream reads live).
  const chunks: number[] = [];
  const reader = ts.readable.getReader();
  const drained = (async () => {
    for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) chunks.push(...value); }
  })();
  sink('ab');
  sink.writeBytes(new Uint8Array([0, 255]));
  await close();
  await drained;
  expect(chunks).toEqual([0x61, 0x62, 0x00, 0xff]);
});

test('sinkToStream close() signals EOF (readable ends)', async () => {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const { close } = sinkToStream(ts.writable);
  await close();
  const reader = ts.readable.getReader();
  const { done } = await reader.read();
  expect(done).toBe(true);
});
