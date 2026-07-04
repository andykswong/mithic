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
  // script-src must NOT gain data: (ever) and must NOT yet gain blob: (that is Task Group D).
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  expect(csp).not.toMatch(/script-src[^;]*blob:/);
  expect(csp).toContain('script-src \'unsafe-inline\' \'unsafe-eval\'');
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

test('negative: connect-src none blocks fetch from inside the iframe', async () => {
  const msg = await probe(/* js */`
    export default async (_boot) => {
      let blocked = false;
      try { await fetch('https://example.com/x'); } catch (_e) { blocked = true; }
      window.parent.postMessage({ id: 1, call: 'probe', args: { blocked } }, '*');
    };
  `);
  expect((msg as { args: { blocked: boolean } })?.args.blocked).toBe(true);
}, 10000);

test('negative: nested Worker is CSP-refused (worker-src absent → default-src none)', async () => {
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
