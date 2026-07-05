import { expect, test } from 'vitest';
import {
  parseMarker, forwardMarkers, marker, sanitizeEvent, sizeBucket,
  DIMENSION_ALLOWLIST, type TelemetryEvent, type TelemetrySink,
} from './telemetry.ts';

test('parseMarker parses a content-free event line into an event', () => {
  const ev = parseMarker('mithic-ev\tprocessed\tinFmt=png\toutFmt=webp\tbytesInBucket=1-5MB\tms=340');
  expect(ev).toEqual({
    name: 'processed',
    dims: { inFmt: 'png', outFmt: 'webp', bytesInBucket: '1-5MB', ms: '340' },
  });
});

test('parseMarker returns null for a non-telemetry line', () => {
  expect(parseMarker('ready')).toBeNull();
  expect(parseMarker('random guest log')).toBeNull();
});

test('sizeBucket maps a byte count to a coarse bucket (never the raw size)', () => {
  expect(sizeBucket(500)).toBe('<100KB');
  expect(sizeBucket(2 * 1024 * 1024)).toBe('1-5MB');
  expect(sizeBucket(50 * 1024 * 1024)).toBe('>20MB');
});

test('sizeBucket boundary values map to the correct bucket', () => {
  // 100KB boundary
  expect(sizeBucket(100 * 1024 - 1)).toBe('<100KB');
  expect(sizeBucket(100 * 1024)).toBe('100KB-1MB');
  // 1MB boundary
  expect(sizeBucket(1024 * 1024 - 1)).toBe('100KB-1MB');
  expect(sizeBucket(1024 * 1024)).toBe('1-5MB');
  // 5MB boundary
  expect(sizeBucket(5 * 1024 * 1024 - 1)).toBe('1-5MB');
  expect(sizeBucket(5 * 1024 * 1024)).toBe('5-20MB');
  // 20MB boundary
  expect(sizeBucket(20 * 1024 * 1024 - 1)).toBe('5-20MB');
  expect(sizeBucket(20 * 1024 * 1024)).toBe('>20MB');
});

test('forwardMarkers streams marker lines from a ReadableStream to the sink', async () => {
  const got: TelemetryEvent[] = [];
  const sink: TelemetrySink = (ev) => { got.push(ev); };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('ready\n'));
      c.enqueue(enc.encode('mithic-ev\tfile_dropped\tinFmt=jpeg\n'));
      c.enqueue(enc.encode('mithic-ev\tdownloaded\toutFmt=webp\n'));
      c.close();
    },
  });
  await forwardMarkers(stream, sink);
  expect(got.map((e) => e.name)).toEqual(['file_dropped', 'downloaded']);
});

test('forwardMarkers delivers a complete multibyte value split across chunk boundaries', async () => {
  // A multibyte char that COMPLETES within the stream must round-trip intact. 'é' = 0xC3 0xA9;
  // we split the stream between those two bytes. Because 'errorClass' is ASCII-only in the
  // allowlist, this event is delivered with the multibyte value STRIPPED (content-free), which
  // still proves the decoder reassembled the char rather than emitting garbage or throwing.
  const got: TelemetryEvent[] = [];
  const sink: TelemetrySink = (ev) => { got.push(ev); };
  const enc = new TextEncoder();
  const bytes = enc.encode('mithic-ev\tprocessed\tinFmt=png\terrorClass=café\n');
  const splitAt = bytes.length - 3; // between the two bytes of the final 'é' before '\n'
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, splitAt));
      c.enqueue(bytes.slice(splitAt));
      c.close();
    },
  });
  await forwardMarkers(stream, sink);
  // Delivered; multibyte 'café' errorClass is stripped by the ASCII-only allowlist (content-free).
  expect(got).toEqual([{ name: 'processed', dims: { inFmt: 'png' } }]);
});

test('forwardMarkers flushes the decoder at stream end (unterminated final marker is not lost)', async () => {
  // The final marker has NO trailing newline, so it lives only in `buf` after the loop.
  // dec.decode() (flush) must run before the final parseMarker(buf) or an incomplete
  // trailing byte held by the streaming decoder would silently vanish. Here the final
  // chunk ends with a lone 0xC3 (start of a 2-byte sequence, never completed): the flush
  // surfaces it as U+FFFD instead of silently dropping bytes, and the marker still parses.
  const got: TelemetryEvent[] = [];
  const sink: TelemetrySink = (ev) => { got.push(ev); };
  const enc = new TextEncoder();
  const bytes = enc.encode('mithic-ev\tprocessed\tinFmt=png\ttargetWidth=1024');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.enqueue(new Uint8Array([0xc3])); // dangling incomplete multibyte byte at stream end
      c.close();
    },
  });
  await forwardMarkers(stream, sink);
  // The unterminated marker is delivered. WITH the flush the dangling byte becomes U+FFFD and
  // appends to the last value, making targetWidth non-numeric → stripped by the allowlist.
  // WITHOUT the flush the dangling byte vanishes and targetWidth would survive as '1024' — so
  // asserting it is stripped proves dec.decode() ran (the flush is present).
  expect(got.length).toBe(1);
  expect(got[0]?.name).toBe('processed');
  expect(got[0]?.dims.inFmt).toBe('png');
  expect(got[0]?.dims.targetWidth).toBeUndefined();
});

test('a serialized event never contains a filename or raw bytes (content-free invariant)', () => {
  // The dims a guest is ALLOWED to emit are a fixed allowlist; assert no free-form value slips through.
  const ev = parseMarker('mithic-ev\tprocessed\tinFmt=png\toutFmt=webp\tsrcWidthBucket=large\ttargetWidth=1024\tms=200')!;
  const serialized = JSON.stringify(ev);
  expect(serialized).not.toMatch(/\.png|\.jpe?g|\.webp|filename|photo/i);
  // Only allowlisted dimension keys.
  for (const k of Object.keys(ev.dims)) expect(k in DIMENSION_ALLOWLIST).toBe(true);
});

test('sanitizeEvent drops disallowed dimension keys a malicious guest tries to smuggle', () => {
  // A guest that emits a filename or raw byte count must not survive sanitization.
  const raw = parseMarker('mithic-ev\tprocessed\tfilename=secret.jpg\tfilepath=/in/secret.jpg\traw_bytes=4242\tinFmt=png')!;
  const clean = sanitizeEvent(raw)!;
  expect(clean.dims).toEqual({ inFmt: 'png' });
  expect(clean.dims).not.toHaveProperty('filename');
  expect(clean.dims).not.toHaveProperty('filepath');
  expect(clean.dims).not.toHaveProperty('raw_bytes');
});

test('sanitizeEvent drops disallowed values on enumerated dimensions', () => {
  // inFmt/outFmt/bucket dims accept only a fixed value set — a smuggled value is dropped.
  const raw = parseMarker('mithic-ev\tprocessed\tinFmt=secret_payload\toutFmt=webp\tbytesInBucket=42424242\tsrcWidthBucket=large')!;
  const clean = sanitizeEvent(raw)!;
  expect(clean.dims).toEqual({ outFmt: 'webp', srcWidthBucket: 'large' });
  expect(clean.dims).not.toHaveProperty('inFmt');
  expect(clean.dims).not.toHaveProperty('bytesInBucket');
});

test('sanitizeEvent keeps free-form-but-bounded dims (targetWidth digits, ms digits) and drops non-conforming ones', () => {
  const ok = sanitizeEvent(parseMarker('mithic-ev\tprocessed\ttargetWidth=1024\tms=340')!)!;
  expect(ok.dims).toEqual({ targetWidth: '1024', ms: '340' });
  // Non-numeric targetWidth / ms are rejected.
  const bad = sanitizeEvent(parseMarker('mithic-ev\tprocessed\ttargetWidth=drop table\tms=/in/x.jpg')!)!;
  expect(bad.dims).toEqual({});
});

test('sanitizeEvent rejects an event with a name outside the allowlist', () => {
  expect(sanitizeEvent({ name: 'exfiltrate', dims: {} })).toBeNull();
});

test('forwardMarkers only forwards sanitized, allowlisted events', async () => {
  const got: TelemetryEvent[] = [];
  const sink: TelemetrySink = (ev) => { got.push(ev); };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('mithic-ev\tprocessed\tinFmt=png\tfilename=secret.jpg\n'));
      c.enqueue(enc.encode('mithic-ev\tnot_an_event\tinFmt=png\n'));
      c.close();
    },
  });
  await forwardMarkers(stream, sink);
  expect(got).toEqual([{ name: 'processed', dims: { inFmt: 'png' } }]);
});

test('parseMarker + sanitizeEvent carry a marker with every allowlisted dimension intact', () => {
  // A realistic near-max event: all 9 allowlisted dimension keys present with values that
  // each satisfy their predicate. This proves the tab-separated line-protocol parser and the
  // sanitizer handle a full, multi-dimension event without dropping or reordering fields —
  // the widest event the funnel ever emits (a `processed` plus every optional dim).
  const dims: Record<string, string> = {
    inFmt: 'png', outFmt: 'webp', srcWidthBucket: 'large', targetWidth: '1024',
    bytesInBucket: '1-5MB', bytesOutBucket: '100KB-1MB', ms: '340',
    errorClass: 'RangeError', cta: 'result-scale',
  };
  // The marker builder emits every key; assert the wire line carries all 9 fields (+ prefix + name).
  const line = marker('processed', dims);
  expect(line.split('\t').length).toBe(2 + Object.keys(dims).length); // prefix, name, 9 k=v

  const parsed = parseMarker(line)!;
  expect(Object.keys(parsed.dims).sort()).toEqual(Object.keys(DIMENSION_ALLOWLIST).sort());

  // Sanitization keeps every one of them: each key is allowlisted and each value conforms.
  const clean = sanitizeEvent(parsed)!;
  expect(clean.name).toBe('processed');
  expect(clean.dims).toEqual(dims);
  // Every allowlisted key is represented — none were silently dropped.
  expect(Object.keys(clean.dims).sort()).toEqual(Object.keys(DIMENSION_ALLOWLIST).sort());
});

test('marker escapes tab and newline characters in dimension values (line-protocol integrity)', () => {
  // A value carrying a tab / newline / CR / backslash together must round-trip losslessly rather
  // than fragmenting the line. `guest.ts` inlines a byte-identical `marker`/`esc` for ?bundle
  // self-containment, so this pins the shared wire contract both sides depend on.
  const value = 'IndexError:\ttoo\nlong\rslash\\end';
  const line = marker('process_error', { errorClass: value });
  // Structural tabs separate the 3 fields; the value's own tab/newline/CR are escaped, so the
  // line does not fragment (no extra tabs from the value) and carries no raw newline/CR.
  expect(line.split('\t').length).toBe(3); // MARKER_PREFIX, name, one k=v — no fragmentation.
  expect(line).not.toMatch(/[\n\r]/); // value newlines/CR escaped, never raw.
  const ev = parseMarker(line)!;
  expect(ev.name).toBe('process_error');
  expect(ev.dims.errorClass).toBe(value);
});

test('marker escapes special characters in dimension keys too', () => {
  const line = marker('process_error', { 'weird\tkey': 'v' } as Record<string, string>);
  const ev = parseMarker(line)!;
  expect(ev.dims['weird\tkey']).toBe('v');
});

test('marker round-trips a literal backslash without corruption', () => {
  const line = marker('process_error', { errorClass: 'a\\tb' });
  const ev = parseMarker(line)!;
  expect(ev.dims.errorClass).toBe('a\\tb');
});
