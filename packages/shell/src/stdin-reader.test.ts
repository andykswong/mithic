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

  test('readLine THEN readAll on a binary body is byte-exact (no re-encode corruption)', async () => {
    // The `{ read hdr; cat; }` idiom over a text header + binary body: the header
    // read must not corrupt the following raw bytes via a UTF-8 round-trip.
    const r = new StdinReader(streamOf(new Uint8Array([
      0x68, 0x64, 0x72, 0x0a,        // "hdr\n"
      0x00, 0xff, 0xfe, 0x41,        // binary body: NUL, 0xFF, 0xFE, 'A'
    ])));
    expect(await r.readLine()).toBe('hdr');
    const body = await r.readAll();
    expect(Array.from(body)).toEqual([0x00, 0xff, 0xfe, 0x41]);
  });

  test('readLine then readAll when the split lands mid-buffer across chunks', async () => {
    const r = new StdinReader(streamOf(
      new Uint8Array([0x61, 0x0a, 0x00]),   // "a\n" + 0x00
      new Uint8Array([0xff, 0xfe]),         // 0xFF 0xFE
    ));
    expect(await r.readLine()).toBe('a');
    expect(Array.from(await r.readAll())).toEqual([0x00, 0xff, 0xfe]);
  });

  test('pumpTo streams remaining raw bytes chunk-by-chunk (binary-exact)', async () => {
    const r = new StdinReader(streamOf(
      new Uint8Array([0x00, 0x01]),
      new Uint8Array([0xff, 0xfe]),
    ));
    const seen: number[] = [];
    await r.pumpTo((chunk) => { seen.push(...chunk); });
    expect(seen).toEqual([0x00, 0x01, 0xff, 0xfe]);
  });

  test('readLine then pumpTo streams the remaining binary body byte-exact', async () => {
    const r = new StdinReader(streamOf(new Uint8Array([
      0x68, 0x0a,             // "h\n"
      0x00, 0xff, 0xfe,       // binary body
    ])));
    expect(await r.readLine()).toBe('h');
    const seen: number[] = [];
    await r.pumpTo((chunk) => { seen.push(...chunk); });
    expect(seen).toEqual([0x00, 0xff, 0xfe]);
  });

  test('readBytes stays byte-aligned after a multibyte char (following readAll exact)', async () => {
    // "é" = 0xC3 0xA9, then "x", then binary 0xFF
    const r = new StdinReader(streamOf(new Uint8Array([0xc3, 0xa9, 0x78, 0xff])));
    expect(await r.readBytes(2)).toBe('éx'); // 2 chars = 3 bytes consumed
    expect(Array.from(await r.readAll())).toEqual([0xff]);
  });
});
