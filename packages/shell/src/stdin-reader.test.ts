import { expect, test, describe } from 'vitest';
import { StdinReader } from './stdin-reader.ts';

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < bytes.length) controller.enqueue(bytes[i++]);
      else controller.close();
    },
  });
}

describe('StdinReader', () => {
  test('readLine returns successive lines then undefined at EOF', async () => {
    const r = new StdinReader(streamOf('a\nb\nc\n'));
    expect(await r.readLine()).toBe('a');
    expect(await r.readLine()).toBe('b');
    expect(await r.readLine()).toBe('c');
    expect(await r.readLine()).toBeUndefined();
  });

  test('readLine returns a final unterminated line before EOF', async () => {
    const r = new StdinReader(streamOf('x\ny'));
    expect(await r.readLine()).toBe('x');
    expect(await r.readLine()).toBe('y');
    expect(await r.readLine()).toBeUndefined();
  });

  test('reassembles a multi-byte char split across chunks', async () => {
    const r = new StdinReader(streamOf(new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac, 0x0a])));
    expect(await r.readLine()).toBe('€');
  });

  test('readAll drains remaining bytes exactly (binary-safe)', async () => {
    const r = new StdinReader(streamOf(new Uint8Array([0x00, 0xff, 0xfe])));
    const all = await r.readAll();
    expect(Array.from(all)).toEqual([0x00, 0xff, 0xfe]);
  });

  test('readBytes(n) returns exactly n chars worth then the rest via readAll', async () => {
    const r = new StdinReader(streamOf('abcdef'));
    expect(await r.readBytes(3)).toBe('abc');
    expect(new TextDecoder().decode(await r.readAll())).toBe('def');
  });

  test('readUntil(delim) reads up to (not including) the delimiter', async () => {
    const r = new StdinReader(streamOf('foo;bar;'));
    expect(await r.readUntil(';', undefined)).toBe('foo');
    expect(await r.readUntil(';', undefined)).toBe('bar');
    expect(await r.readUntil(';', undefined)).toBeUndefined();
  });

  test('empty stream: readLine → undefined, readAll → empty', async () => {
    const r = new StdinReader(streamOf());
    expect(await r.readLine()).toBeUndefined();
    expect((await r.readAll()).byteLength).toBe(0);
  });
});
