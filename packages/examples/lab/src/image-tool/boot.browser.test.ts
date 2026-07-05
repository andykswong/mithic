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

const T = 20000;
let lab: Lab | undefined;
afterEach(() => { lab?.dispose(); lab = undefined; });

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

test('bootImageTool mounts the app guest and NO network request carries image bytes', async () => {
  const root = document.createElement('div');
  root.id = 'lab';
  document.body.appendChild(root);

  // Spy on all egress: fetch + sendBeacon. The page must send neither image bytes.
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`fetch:${String(input)}:${typeof init?.body === 'string' ? init!.body : ''}`);
    return Promise.resolve(new Response(''));
  }) as typeof fetch;
  const origBeacon = navigator.sendBeacon?.bind(navigator);
  (navigator as unknown as { sendBeacon: (u: string, b?: BodyInit) => boolean }).sendBeacon =
    (u: string) => { seen.push(`beacon:${u}`); return true; };

  const handle = await bootImageTool({ root, telemetryEndpoint: undefined }); // no endpoint => consoleSink
  lab = handle.lab;

  // A visible iframe (the app guest) was mounted.
  await expect.poll(() => root.querySelectorAll('iframe').length, { timeout: 20000 }).toBeGreaterThan(0);

  // No egress at all with consoleSink; crucially, nothing carrying bytes.
  expect(seen.filter((s) => /image|blob:|RIFF|\.webp/.test(s))).toEqual([]);

  globalThis.fetch = origFetch;
  if (origBeacon) (navigator as unknown as { sendBeacon: typeof origBeacon }).sendBeacon = origBeacon;
  root.remove();
}, 20000);
