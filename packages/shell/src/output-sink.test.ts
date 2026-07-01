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
});
