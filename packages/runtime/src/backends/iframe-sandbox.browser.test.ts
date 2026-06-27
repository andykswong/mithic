/**
 * Browser security-regression tests for IframeRuntime (audit §9 + pid↔source binding).
 *
 * These run in real Chromium via Playwright/Vitest browser mode.
 *
 * §9: the sandboxed guest iframe MUST be created with `sandbox="allow-scripts"` and
 * MUST NOT carry `allow-same-origin` — without that flag the guest runs in an opaque
 * origin and cannot reach parent DOM/storage or break out of the sandbox. A regression
 * that added `allow-same-origin` (e.g. to "fix" a blob: import) would silently destroy
 * the isolation boundary, so we assert it explicitly here.
 *
 * source binding: the runtime's inbound `message` listener filters by
 * `e.source !== iframe.contentWindow` (iframe.ts ~line 106) — the per-process listener
 * is a closure over that one iframe, so a message whose `e.source` is NOT the guest's
 * own contentWindow must never reach that process's onMessage callbacks. We prove this
 * by posting a forged SyscallRequest from the top window (whose `e.source` is the top
 * window, not the guest iframe) and asserting it is dropped — for one process and, to
 * rule out cross-process leakage, for two processes at once.
 *
 * NOTE on scope: the binding is by contentWindow IDENTITY (the closure), not by an
 * explicit pid→source map, and these tests exercise the top-window-source case. A
 * dedicated test forging from a *second guest's* contentWindow into the first guest's
 * listener (true cross-iframe spoof) — plus an explicit pid↔source map in the runtime —
 * remains a hardening follow-up (design doc §9/§15).
 */
import { expect, test } from 'vitest';
import { IframeRuntime } from './iframe.ts';

const baseInit = (pid: number) => ({
  type: 'init' as const,
  entry: '' as const,
  args: [] as string[],
  env: {} as Record<string, string>,
  cwd: '/',
  pid,
  ppid: 0,
  capabilities: [],
});

test('IframeRuntime (window mode): sandbox is exactly allow-scripts, never allow-same-origin', async () => {
  const runtime = new IframeRuntime();
  const frame = document.createElement('div');
  frame.style.cssText = 'width:300px;height:200px;';
  document.body.appendChild(frame);

  const ch = new MessageChannel();
  const handle = await runtime.spawn('1;', {
    init: baseInit(1),
    transfer: [ch.port2],
    display: { mode: 'window', container: frame, width: 300, height: 200, title: 'T' },
  });

  const iframe = frame.querySelector('iframe');
  expect(iframe).not.toBeNull();
  const sandbox = iframe!.getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  // §9 regression guard: allow-same-origin would let the guest break opaque-origin isolation.
  expect(sandbox).not.toContain('allow-same-origin');

  runtime.dispose(handle);
  frame.remove();
});

test('IframeRuntime (inline mode): sandbox is exactly allow-scripts, never allow-same-origin', async () => {
  const runtime = new IframeRuntime();
  const frame = document.createElement('div');
  document.body.appendChild(frame);

  const ch = new MessageChannel();
  const handle = await runtime.spawn('1;', {
    init: baseInit(2),
    transfer: [ch.port2],
    display: { mode: 'inline', container: frame, width: 200, height: 150 },
  });

  const iframe = frame.querySelector('iframe');
  expect(iframe).not.toBeNull();
  const sandbox = iframe!.getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');

  runtime.dispose(handle);
  frame.remove();
});

test('IframeRuntime: a message NOT from the guest iframe contentWindow is ignored (pid↔source binding)', async () => {
  const runtime = new IframeRuntime();

  // A trivial guest — it never posts anything itself, so any callback hit can only be
  // from a message the runtime's source filter let through.
  const handle = await runtime.spawn('export default async () => {};', {
    init: baseInit(3),
  });

  let sawForged = false;
  runtime.onMessage(handle, (m) => {
    if (m != null && typeof m === 'object' && (m as { call?: string }).call === 'forged') {
      sawForged = true;
    }
  });

  // Forge a SyscallRequest from the TOP window. Its `e.source` is the top window — NOT
  // the guest iframe's contentWindow — so the runtime's `e.source !== iframe.contentWindow`
  // guard must drop it before it reaches the callback.
  window.postMessage({ id: 1, call: 'forged', args: { evil: true } }, '*');

  // Give the (rejected) message ample time to deliver if the filter were broken.
  await new Promise<void>((r) => setTimeout(r, 300));

  expect(sawForged).toBe(false);

  runtime.dispose(handle);
});

test('IframeRuntime: forged message to one process does not reach a DIFFERENT process', async () => {
  // Two processes, two iframes. A message posted from the top window must reach neither;
  // this strengthens the binding assertion by ruling out any cross-process leakage.
  const runtime = new IframeRuntime();

  const h1 = await runtime.spawn('export default async () => {};', { init: baseInit(10) });
  const h2 = await runtime.spawn('export default async () => {};', { init: baseInit(11) });

  let hits = 0;
  const tag = (m: unknown) => {
    if (m != null && typeof m === 'object' && (m as { call?: string }).call === 'spoof') hits++;
  };
  runtime.onMessage(h1, tag);
  runtime.onMessage(h2, tag);

  window.postMessage({ id: 7, call: 'spoof', args: {} }, '*');
  await new Promise<void>((r) => setTimeout(r, 300));

  expect(hits).toBe(0);

  runtime.dispose(h1);
  runtime.dispose(h2);
});
