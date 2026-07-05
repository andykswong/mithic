/**
 * The guest-side wire-format helpers for content-free telemetry markers.
 *
 * This module has **NO host imports** on purpose: the image-tool GUI guest is a
 * self-contained `?bundle` — importing the host {@link module:telemetry} would drag
 * host-only code (sinks, `sanitizeEvent`, the whole allowlist machinery) into the
 * guest bundle. Instead we duplicate ONLY the tiny escape + marker builder here, and
 * keep it byte-compatible with `telemetry.ts`'s `esc()`/`marker()`/`parseMarker()` so
 * a value carrying a tab/newline/CR/backslash round-trips through the host parser
 * intact rather than fragmenting the tab/newline-delimited line protocol.
 *
 * MUST stay in sync with `telemetry.ts` (`MARKER_PREFIX` + `esc`). A test in
 * `guest.browser.test.ts` pins the round-trip against the host `parseMarker()`.
 */

/** The wire marker prefix; MUST equal `telemetry.ts` `MARKER_PREFIX`. */
export const GUEST_MARKER_PREFIX = 'mithic-ev';

/**
 * Escape control characters structural in the tab/newline line protocol. Byte-for-byte
 * identical to `telemetry.ts` `esc()` so the host `unesc()` reverses it exactly.
 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Build a marker line: `mithic-ev\t<name>\t<k=v>\t<k=v>...` with keys and values escaped. */
export function guestMarker(name: string, dims: Record<string, string> = {}): string {
  const kvs = Object.entries(dims).map(([k, v]) => `${esc(k)}=${esc(v)}`);
  return [GUEST_MARKER_PREFIX, name, ...kvs].join('\t');
}

/** Coarse size bucket — NEVER the raw byte count. Mirrors `telemetry.ts` `sizeBucket()`. */
export function sizeBucket(b: number): string {
  if (b < 100 * 1024) return '<100KB';
  if (b < 1024 * 1024) return '100KB-1MB';
  if (b < 5 * 1024 * 1024) return '1-5MB';
  if (b < 20 * 1024 * 1024) return '5-20MB';
  return '>20MB';
}

/** Coarse source-width bucket. Mirrors `telemetry.ts` `widthBucket()`. */
export function widthBucket(px: number): string {
  if (px <= 512) return 'small';
  if (px <= 1536) return 'medium';
  if (px <= 4096) return 'large';
  return 'xlarge';
}
