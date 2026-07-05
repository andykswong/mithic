import { expect, test } from 'vitest';
import {
  parseMarker, forwardMarkers, sizeBucket, type TelemetryEvent, type TelemetrySink,
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

test('a serialized event never contains a filename or raw bytes (content-free invariant)', () => {
  // The dims a guest is ALLOWED to emit are a fixed allowlist; assert no free-form value slips through.
  const ev = parseMarker('mithic-ev\tprocessed\tinFmt=png\toutFmt=webp\tsrcWidthBucket=large\ttargetWidth=1024\tms=200')!;
  const serialized = JSON.stringify(ev);
  expect(serialized).not.toMatch(/\.png|\.jpe?g|\.webp|filename|photo/i);
  // Only allowlisted dimension keys.
  const allowed = new Set(['inFmt', 'outFmt', 'srcWidthBucket', 'targetWidth', 'bytesInBucket', 'bytesOutBucket', 'ms', 'errorClass', 'cta']);
  for (const k of Object.keys(ev.dims)) expect(allowed.has(k)).toBe(true);
});
