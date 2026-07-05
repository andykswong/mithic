/**
 * Task V5+ (injectable runtime backend). {@link createLab} accepts an optional
 * runtime parameter, defaulting to {@link WorkerRuntime} for backward compatibility.
 * Callers (e.g., image-tool product page) can inject an {@link IframeRuntime} to
 * run guests as visible GUI guests that paint their own preview. This test verifies
 * both the default and injected paths work end-to-end.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { bootImageTool } from './boot.ts';
import { DIMENSION_ALLOWLIST } from './telemetry.ts';

const T = 20000;
let lab: Lab | undefined;
afterEach(() => { lab?.dispose(); lab = undefined; });

/** A tiny PNG the guest's MITHIC_TEST_DROP hook can decode, as base64. */
async function fixturePngB64(width = 40, height = 20): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return btoa(String.fromCharCode(...bytes));
}

test('createLab defaults to a working runtime (backward-compatible) and runs a command', async () => {
  lab = await createLab({ persistStorage: null });
  const out = await lab.run('echo hi');
  expect(out).toContain('hi');
}, T);

test('createLab accepts an injected IframeRuntime and still runs a command', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  lab = await createLab({ persistStorage: null, runtime: new IframeRuntime({ container }) });
  const out = await lab.run('echo iframe-ok');
  expect(out).toContain('iframe-ok');
  container.remove();
}, T);

test('bootImageTool with NO endpoint (consoleSink) makes zero network egress', async () => {
  const root = document.createElement('div');
  root.id = 'lab';
  document.body.appendChild(root);

  // Spy on all egress: fetch + sendBeacon. With no endpoint the page must call neither.
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  const origBeacon = navigator.sendBeacon?.bind(navigator);
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`fetch:${String(input)}:${typeof init?.body === 'string' ? init!.body : ''}`);
      return Promise.resolve(new Response(''));
    }) as typeof fetch;
    (navigator as unknown as { sendBeacon: (u: string, b?: BodyInit) => boolean }).sendBeacon =
      (u: string) => { seen.push(`beacon:${u}`); return true; };

    const handle = await bootImageTool({ root, telemetryEndpoint: undefined }); // no endpoint => consoleSink
    lab = handle.lab;

    // A visible iframe (the app guest) was mounted.
    await expect.poll(() => root.querySelectorAll('iframe').length, { timeout: T }).toBeGreaterThan(0);

    // consoleSink never touches the network — no fetch, no beacon, at all.
    expect(seen).toEqual([]);
  } finally {
    globalThis.fetch = origFetch;
    if (origBeacon) (navigator as unknown as { sendBeacon: typeof origBeacon }).sendBeacon = origBeacon;
    root.remove();
  }
}, T);

// The critical no-upload invariant under LOAD: drive the guest's full funnel
// (drop -> process -> preview) through the REAL boot path with a telemetry endpoint
// set, so the beaconSink actually fires. Then prove (1) sendBeacon was invoked (the
// endpoint path works), (2) every beacon body carries ONLY allowlisted content-free
// dims — never a filename, never a byte count, never image data — and (3) nothing in
// any egress (URL or body) is image-shaped (no base64 PNG/WEBP payload, no blob: URL).
test('bootImageTool funnel with an endpoint egresses ONLY content-free markers — no image bytes', async () => {
  const root = document.createElement('div');
  root.id = 'lab';
  document.body.appendChild(root);

  const pngB64 = await fixturePngB64(40, 20);
  // Anything an image byte-stream would look like if it leaked: the raw base64, the
  // WEBP output magic, blob: URLs, or a filename. None may appear in any egress.
  const forbidden = [pngB64, pngB64.slice(0, 64), 'RIFF', 'WEBP', 'photo.png', 'blob:'];

  // Capture the FULL beacon/fetch payload (URL + decoded body), not just the URL.
  const egress: string[] = [];
  const bodyOf = async (b?: BodyInit | null): Promise<string> => {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (b instanceof Blob) return b.text();
    if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
    if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b as ArrayBufferView as Uint8Array);
    return String(b);
  };
  const beaconBodies: string[] = [];
  const origFetch = globalThis.fetch;
  const origBeacon = navigator.sendBeacon?.bind(navigator);
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      egress.push(`fetch:${String(input)}\n${await bodyOf(init?.body)}`);
      return new Response('');
    }) as typeof fetch;
    (navigator as unknown as { sendBeacon: (u: string, b?: BodyInit) => boolean }).sendBeacon =
      (u: string, b?: BodyInit) => {
        // Read the body async but record synchronously-resolvable text for assertion.
        void bodyOf(b).then((t) => { egress.push(`beacon:${u}\n${t}`); beaconBodies.push(t); });
        return true;
      };

    const handle = await bootImageTool({
      root,
      telemetryEndpoint: 'https://telemetry.example.test/e', // beaconSink path
      guestEnv: {
        MITHIC_TEST_DROP: pngB64,
        MITHIC_TEST_NAME: 'photo.png',
        MITHIC_TEST_WIDTH: '16',
        MITHIC_TEST_FORMAT: 'webp',
      },
    });
    lab = handle.lab;

    // Wait for the funnel to complete end-to-end: the 'processed' marker only fires
    // after the guest ran the resize-convert workflow and produced output bytes.
    await expect.poll(
      () => beaconBodies.some((b) => b.includes('"processed"')),
      { timeout: T },
    ).toBe(true);
    // The preview marker fires after the blob: preview paints inside the sandbox.
    await expect.poll(
      () => beaconBodies.some((b) => b.includes('"previewed"')),
      { timeout: T },
    ).toBe(true);

    // (1) The endpoint path fired at least one beacon (proves beaconSink selection).
    expect(beaconBodies.length).toBeGreaterThan(0);

    // (2) Every beacon body is content-free: shape { e: name, d: dims } and each dim
    // key is on the strict allowlist. No filename, no raw byte count, no image data.
    for (const body of beaconBodies) {
      const parsed = JSON.parse(body) as { e: string; d: Record<string, string> };
      expect(typeof parsed.e).toBe('string');
      for (const key of Object.keys(parsed.d)) {
        expect(Object.prototype.hasOwnProperty.call(DIMENSION_ALLOWLIST, key)).toBe(true);
      }
    }

    // (3) Nothing image-shaped leaked in ANY egress — URL or body.
    for (const line of egress) {
      for (const needle of forbidden) {
        expect(line.includes(needle)).toBe(false);
      }
    }
  } finally {
    globalThis.fetch = origFetch;
    if (origBeacon) (navigator as unknown as { sendBeacon: typeof origBeacon }).sendBeacon = origBeacon;
    lab?.dispose();
    lab = undefined;
    root.remove();
  }
}, T);
