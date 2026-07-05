import { test, expect } from 'vitest';
import { buildSrcdoc } from './iframe-bootstrap.ts';
import { IframeRuntime } from './iframe.ts';

// A2/A3 add runtime paint + negative tests; A1 pins the policy string itself.
test('buildSrcdoc CSP: passive blob:/data: on img/font/media, egress locked', () => {
  const html = buildSrcdoc();
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1];
  expect(csp).toContain('default-src \'none\'');
  expect(csp).toContain('img-src blob: data:');
  expect(csp).toContain('media-src blob: data:');
  expect(csp).toContain('font-src blob: data:');
  expect(csp).toContain('connect-src \'none\'');
  expect(csp).toContain('form-action \'none\'');
  expect(csp).toContain('base-uri \'none\'');
  expect(csp).toContain('webrtc \'block\'');
  // script-src GAINED blob: (OF1 — for the guest-module import()) but must NEVER gain data:.
  expect(csp).toMatch(/script-src[^;]*\bblob:/);
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  expect(csp).toContain('script-src \'unsafe-inline\' \'unsafe-eval\' blob:');
  // worker-src 'none' is EXPLICIT (OF1): with blob: now in script-src, an ABSENT worker-src
  // would inherit it via the child-src→script-src fallback and permit `new Worker(blob:)`.
  expect(csp).toContain('worker-src \'none\'');
  // Scheme must be scoped to specific directives, never default-src.
  expect(csp).not.toMatch(/default-src[^;]*blob:/);
  expect(csp).not.toMatch(/default-src[^;]*data:/);
});

test('WebRTC shim: RTCPeerConnection is deleted before the guest runs', async () => {
  const rt = new IframeRuntime();
  const code = /* js */`
    export default async (_boot) => {
      const gone = typeof RTCPeerConnection === 'undefined'
        && typeof webkitRTCPeerConnection === 'undefined'
        && typeof mozRTCPeerConnection === 'undefined'
        && typeof RTCDataChannel === 'undefined';
      window.parent.postMessage({ id: 1, call: 'webrtc-check', args: { gone } }, '*');
    };
  `;
  const init = { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] };
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise<void>((r) => setTimeout(r, 500));
  const msg = received.find((m) => (m as { call?: string })?.call === 'webrtc-check') as { args: { gone: boolean } } | undefined;
  expect(msg?.args.gone).toBe(true);
  rt.dispose(handle);
}, 10000);

// Helper: spawn a guest that reports a boolean probe result on stdout-less message channel.
async function probe(code: string): Promise<Record<string, unknown> | undefined> {
  const rt = new IframeRuntime();
  const init = { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] };
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise<void>((r) => setTimeout(r, 800));
  rt.dispose(handle);
  return received.find((m) => (m as { call?: string })?.call === 'probe') as Record<string, unknown> | undefined;
}

test('a guest renders a blob: <img> it produced — it actually paints under the new CSP', async () => {
  const msg = await probe(/* js */`
    export default async (_boot) => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      const img = document.createElement('img');
      let painted = false, err = false;
      img.onload = () => { painted = img.naturalWidth > 0; report(); };
      img.onerror = () => { err = true; report(); };
      let done = false;
      function report() {
        if (done) return; done = true;
        window.parent.postMessage({ id: 1, call: 'probe', args: { painted, err } }, '*');
      }
      document.body.appendChild(img);
      img.src = url;
      setTimeout(report, 600);
    };
  `);
  expect(msg).toBeDefined();
  expect((msg as { args: { painted: boolean; err: boolean } }).args.painted).toBe(true);
  expect((msg as { args: { err: boolean } }).args.err).toBe(false);
}, 10000);

test('negative: connect-src none blocks fetch + WebSocket egress (CSP-specific)', async () => {
  // A bare `try { await fetch(cross-origin) }` is UNSOUND: a null-origin cross-origin
  // fetch rejects on CORS/network regardless of CSP, so it would pass even if connect-src
  // were opened to https:/*. We instead detect the CSP itself: register a
  // securitypolicyviolation listener and require a violation whose directive matches
  // /connect/. This flips to false the moment connect-src is loosened.
  // Empirically (this repo's Chromium): fetch → connect-src violation fires; WebSocket
  // does NOT throw synchronously from `new WebSocket()` under connect-src 'none' — it also
  // surfaces as a connect-src securitypolicyviolation. So both are asserted via the event.
  const msg = await probe(/* js */`
    export default async (_boot) => {
      const dirs = new Set();
      document.addEventListener('securitypolicyviolation', (e) => {
        if (/connect/.test(e.violatedDirective)) dirs.add(e.blockedURI.slice(0, 3));
      });
      let fetchViolation = false, wsViolation = false;
      // fetch
      try { await fetch('https://example.com/x'); } catch (_e) { /* CORS/network — not the signal */ }
      // WebSocket (constructor does not throw synchronously in Chromium; the block is a CSP violation)
      try { new WebSocket('wss://example.com'); } catch (_e) { /* if an engine throws, that is also a block */ }
      // Give the violation events a tick to dispatch.
      await new Promise((r) => setTimeout(r, 300));
      fetchViolation = dirs.has('htt');
      wsViolation = dirs.has('wss');
      window.parent.postMessage({ id: 1, call: 'probe', args: { fetchViolation, wsViolation } }, '*');
    };
  `);
  expect((msg as { args: { fetchViolation: boolean } })?.args.fetchViolation).toBe(true);
  expect((msg as { args: { wsViolation: boolean } })?.args.wsViolation).toBe(true);
}, 10000);

test('negative: nested Worker is CSP-refused (explicit worker-src none)', async () => {
  // worker-src 'none' is pinned EXPLICITLY (OF1): once script-src gained blob:, an absent
  // worker-src would inherit it (child-src→script-src fallback) and permit new Worker(blob:).
  // Chromium does NOT throw synchronously from `new Worker(blob:)` under a worker-src
  // violation — it fires a `securitypolicyviolation` event + an async worker `error`
  // event and the worker never runs (no message). "blocked" therefore = the constructor
  // threw OR a worker-src CSP violation fired OR the worker errored/never posted. This
  // widens the catch to the observed async surface; it does NOT soft-assert — a nested
  // Worker that actually RAN (posted its message) would fail this.
  const msg = await probe(/* js */`
    export default async (_boot) => {
      let blocked = false, ran = false;
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.violatedDirective && /worker|default|script|child/.test(e.violatedDirective)) blocked = true;
      });
      try {
        const w = new Worker(URL.createObjectURL(new Blob(['self.postMessage(1)'], { type: 'text/javascript' })));
        w.onerror = () => { blocked = true; };
        w.onmessage = () => { ran = true; };
        await new Promise((r) => setTimeout(r, 400));
        w.terminate();
      } catch (_e) { blocked = true; }
      window.parent.postMessage({ id: 1, call: 'probe', args: { blocked: blocked && !ran } }, '*');
    };
  `);
  expect((msg as { args: { blocked: boolean } })?.args.blocked).toBe(true);
}, 10000);

test('negative: script-src did NOT gain data: — a data: module import is refused', async () => {
  const msg = await probe(/* js */`
    export default async (_boot) => {
      let refused = false;
      try { await import('data:text/javascript,export default 1'); } catch (_e) { refused = true; }
      window.parent.postMessage({ id: 1, call: 'probe', args: { refused } }, '*');
    };
  `);
  expect((msg as { args: { refused: boolean } })?.args.refused).toBe(true);
}, 10000);

test('negative: a guest cannot mint a child realm with pristine RTCPeerConnection (frame-src → default-src none)', async () => {
  // The WebRTC shim only deletes constructors in the TOP guest realm. A child
  // iframe would get fresh globals — that vector is closed NOT by the shim but by
  // default-src 'none' (frame-src fallback): the child frame cannot be created as a
  // live realm, so its inline script never runs. Empirically (this repo's Chromium) NO
  // securitypolicyviolation event fires on the parent for a blocked child frame, so the
  // sound, control-specific signal is childRan === false. A positive control proves inline
  // script DOES run at top level, so if frame-src/default-src were opened the child would
  // run and this flips to a failure. childRan flips true (test fails) if the vector opens.
  const msg = await probe(/* js */`
    export default async (_boot) => {
      let topInline = false, childRan = false;
      window.addEventListener('message', (e) => { if (e.data && e.data.__child) childRan = true; });
      // Positive control: a top-level inline <script> runs under script-src 'unsafe-inline'.
      const s = document.createElement('script');
      s.textContent = 'window.__topInline = true;';
      document.head.appendChild(s);
      topInline = window.__topInline === true;
      // Vector: child <iframe srcdoc> attempting to run inline script + reach a pristine realm.
      const f = document.createElement('iframe');
      f.srcdoc = '<script>window.top.postMessage({ __child: 1, rtc: typeof RTCPeerConnection !== "undefined" }, "*");<\\/script>';
      document.body.appendChild(f);
      await new Promise((r) => setTimeout(r, 500));
      window.parent.postMessage({ id: 1, call: 'probe', args: { topInline, childRan } }, '*');
    };
  `);
  // Sanity: inline script works in the guest realm, so a runnable child WOULD have run.
  expect((msg as { args: { topInline: boolean } })?.args.topInline).toBe(true);
  // Control: the child frame was CSP-refused — its script never executed.
  expect((msg as { args: { childRan: boolean } })?.args.childRan).toBe(false);
}, 10000);
