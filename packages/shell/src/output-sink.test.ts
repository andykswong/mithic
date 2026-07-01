import { expect, test, describe } from 'vitest';
import { toSink, type OutputSink } from './output-sink.ts';

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
