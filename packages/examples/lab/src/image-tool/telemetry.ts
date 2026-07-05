/**
 * Content-free, first-party telemetry (spec §7). The app guest emits marker lines
 * on stdout; the host parses them and forwards to a pluggable sink. NEVER a
 * filename, never image bytes — only an event name + a fixed allowlist of coarse,
 * bucketed dimensions. This keeps "your files never touch us" literally true: image
 * bytes never leave the device, and the only egress is a content-free beacon.
 */

/** The wire marker prefix the guest writes: `mithic-ev\t<name>\t<k=v>\t<k=v>...`. */
export const MARKER_PREFIX = 'mithic-ev';

/** The allowlist of event names the page emits. */
export type TelemetryEventName =
  | 'page_view' | 'file_dropped' | 'processing_started' | 'processed'
  | 'process_error' | 'previewed' | 'downloaded' | 'cta_clicked';

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
    dims[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return { name, dims };
}

/** Build a marker line (used by the guest). */
export function marker(name: TelemetryEventName, dims: Record<string, string> = {}): string {
  const kvs = Object.entries(dims).map(([k, v]) => `${k}=${v}`);
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

/** Read stdout marker lines from `readable` and forward parsed events to `sink`. */
export async function forwardMarkers(readable: ReadableStream<Uint8Array>, sink: TelemetrySink): Promise<void> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = parseMarker(line);
        if (ev) sink(ev);
      }
    }
    const ev = parseMarker(buf);
    if (ev) sink(ev);
  } finally {
    reader.releaseLock();
  }
}
