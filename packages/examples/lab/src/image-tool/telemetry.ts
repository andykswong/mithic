/**
 * Content-free, first-party telemetry (spec §7). The app guest emits marker lines
 * on stdout; the host parses them and forwards to a pluggable sink. NEVER a
 * filename, never image bytes — only an event name + a fixed allowlist of coarse,
 * bucketed dimensions. This keeps "your files never touch us" literally true: image
 * bytes never leave the device, and the only egress is a content-free beacon.
 *
 * The allowlist is enforced host-side (`sanitizeEvent`), not merely by convention in
 * the guest: `forwardMarkers` drops any event name or dimension the guest is not
 * permitted to emit, so a compromised/misbehaving guest cannot smuggle a filename or
 * raw byte count out through the beacon.
 */

/** The wire marker prefix the guest writes: `mithic-ev\t<name>\t<k=v>\t<k=v>...`. */
export const MARKER_PREFIX = 'mithic-ev';

/** The allowlist of event names the page emits. */
export type TelemetryEventName =
  | 'page_view' | 'file_dropped' | 'processing_started' | 'processed'
  | 'process_error' | 'previewed' | 'rendered' | 'downloaded' | 'cta_clicked';

const EVENT_NAMES: ReadonlySet<string> = new Set<TelemetryEventName>([
  'page_view', 'file_dropped', 'processing_started', 'processed',
  'process_error', 'previewed', 'rendered', 'downloaded', 'cta_clicked',
]);

export interface TelemetryEvent {
  name: string;
  dims: Record<string, string>;
}

export type TelemetrySink = (event: TelemetryEvent) => void;

/** Coarse size bucket — NEVER the raw byte count. */
export function sizeBucket(bytes: number): string {
  if (bytes < 100 * 1024) return '<100KB';
  if (bytes < 1024 * 1024) return '100KB-1MB';
  if (bytes < 5 * 1024 * 1024) return '1-5MB';
  if (bytes < 20 * 1024 * 1024) return '5-20MB';
  return '>20MB';
}

/** Coarse source-width bucket. */
export function widthBucket(px: number): string {
  if (px <= 512) return 'small';
  if (px <= 1536) return 'medium';
  if (px <= 4096) return 'large';
  return 'xlarge';
}

const FORMAT_VALUES = ['png', 'jpeg', 'jpg', 'webp', 'gif', 'bmp', 'avif', 'unknown'];
const SIZE_BUCKETS = ['<100KB', '100KB-1MB', '1-5MB', '5-20MB', '>20MB'];
const WIDTH_BUCKETS = ['small', 'medium', 'large', 'xlarge'];
/** Bounded free-form: a run of digits (target width / elapsed-ms), capped so it can carry no payload. */
const DIGITS = (max: number) => (v: string) => /^\d+$/.test(v) && v.length <= max;

/**
 * The strict dimension allowlist (spec §7). Each key maps to a predicate that a value
 * MUST satisfy; a key not present here, or a value that fails its predicate, is
 * content and is dropped. This is what makes the content-free invariant *enforced*
 * rather than aspirational.
 */
export const DIMENSION_ALLOWLIST: Readonly<Record<string, (value: string) => boolean>> = {
  inFmt: (v) => FORMAT_VALUES.includes(v),
  outFmt: (v) => FORMAT_VALUES.includes(v),
  srcWidthBucket: (v) => WIDTH_BUCKETS.includes(v),
  targetWidth: DIGITS(6),
  bytesInBucket: (v) => SIZE_BUCKETS.includes(v),
  bytesOutBucket: (v) => SIZE_BUCKETS.includes(v),
  ms: DIGITS(9),
  errorClass: (v) => /^[A-Za-z][A-Za-z0-9]*$/.test(v) && v.length <= 64,
  cta: (v) => /^[A-Za-z0-9_-]+$/.test(v) && v.length <= 64,
};

/**
 * Reduce a parsed marker to a content-free event: an event whose name is on the
 * allowlist and whose dims contain only allowlisted keys with allowlisted values.
 * Returns null if the event name itself is not permitted.
 */
export function sanitizeEvent(event: TelemetryEvent): TelemetryEvent | null {
  if (!EVENT_NAMES.has(event.name)) return null;
  const dims: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.dims)) {
    const ok = DIMENSION_ALLOWLIST[k];
    if (ok && ok(v)) dims[k] = v;
  }
  return { name: event.name, dims };
}

/** Escape control characters that are structural in the tab/newline line protocol. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Reverse {@link esc}. */
function unesc(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c);
}

/** Parse one stdout line; returns null if it is not a telemetry marker. */
export function parseMarker(line: string): TelemetryEvent | null {
  const trimmed = line.replace(/\r?\n$/, '');
  const parts = trimmed.split('\t');
  if (parts[0] !== MARKER_PREFIX || parts.length < 2) return null;
  const name = parts[1];
  const dims: Record<string, string> = {};
  for (const kv of parts.slice(2)) {
    const eq = kv.indexOf('=');
    if (eq === -1) continue;
    dims[unesc(kv.slice(0, eq))] = unesc(kv.slice(eq + 1));
  }
  return { name, dims };
}

/** Build a marker line (used by the guest). */
export function marker(name: TelemetryEventName, dims: Record<string, string> = {}): string {
  const kvs = Object.entries(dims).map(([k, v]) => `${esc(k)}=${esc(v)}`);
  return [MARKER_PREFIX, name, ...kvs].join('\t');
}

/** A no-op-ish sink for offline/dev: logs to console, sends nothing over the network. */
export const consoleSink: TelemetrySink = (ev) => {
  // eslint-disable-next-line no-console
  console.debug('[telemetry]', ev.name, ev.dims);
};

/**
 * A first-party beacon sink. Sends a content-free JSON body to `endpoint` via
 * `sendBeacon` (falls back to `fetch(keepalive)`). No cookies, no third-party SDK.
 */
export function beaconSink(endpoint: string): TelemetrySink {
  return (ev) => {
    const body = JSON.stringify({ e: ev.name, d: ev.dims });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } });
    }
  };
}

/**
 * Read stdout marker lines from `readable`, sanitize each against the allowlist, and
 * forward the content-free events to `sink`. An event that is not a valid telemetry
 * marker, or whose name is not allowlisted, is dropped; disallowed dimensions are
 * stripped before forwarding.
 */
export async function forwardMarkers(readable: ReadableStream<Uint8Array>, sink: TelemetrySink): Promise<void> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const emit = (line: string): void => {
    const ev = parseMarker(line);
    if (!ev) return;
    const clean = sanitizeEvent(ev);
    if (clean) sink(clean);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        emit(line);
      }
    }
    // Flush any bytes the decoder buffered mid-multibyte-sequence at stream end.
    buf += dec.decode();
    emit(buf);
  } finally {
    reader.releaseLock();
  }
}
