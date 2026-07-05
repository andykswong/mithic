import { test, expect } from 'vitest';
import { buildSrcdoc } from './iframe-bootstrap.ts';
import { IframeRuntime } from './iframe.ts';

test('script-src gains blob: (for the guest-module import) but never data:', () => {
  const csp = buildSrcdoc().match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1];
  expect(csp).toMatch(/script-src[^;]*\bblob:/);
  expect(csp).not.toMatch(/script-src[^;]*\bdata:/);
});

function baseInit(pid: number) {
  return { type: 'init' as const, entry: 'inline' as const, args: ['prog'], env: {}, cwd: '/', pid, ppid: 0, capabilities: [] };
}

test('iframe OF1: ESM guest loads via blob: module and sees boot.imports', async () => {
  const rt = new IframeRuntime();
  const code = /* js */`
    export default async (boot) => {
      window.parent.postMessage({ id: 1, call: 'ran', args: { pid: boot.init.pid, hasImports: 'imports' in boot } }, '*');
    };
  `;
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init: baseInit(11) });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 800));
  const msg = received.find((m) => (m as { call?: string })?.call === 'ran') as { args: { pid: number; hasImports: boolean } } | undefined;
  expect(msg?.args.pid).toBe(11);
  expect(msg?.args.hasImports).toBe(true);
  rt.dispose(handle);
}, 10000);

test('iframe OF1: dep loaded via boot.imports (blob: module) resolves and runs', async () => {
  const rt = new IframeRuntime();
  const code = /* js */`
    export default async (boot) => {
      const { hello } = await import(boot.imports['dep']);
      window.parent.postMessage({ id: 2, call: 'dep-ran', args: { v: hello() } }, '*');
    };
  `;
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init: baseInit(12), guestImports: { dep: 'export const hello = () => 42;' } });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 800));
  const msg = received.find((m) => (m as { call?: string })?.call === 'dep-ran') as { args: { v: number } } | undefined;
  expect(msg?.args.v).toBe(42);
  rt.dispose(handle);
}, 10000);

test('iframe OF1: un-allowlisted dep is fail-loud (import(undefined) throws → __mithic_error)', async () => {
  const rt = new IframeRuntime();
  const code = /* js */`
    export default async (boot) => { await import(boot.imports['not-there']); };
  `;
  const errors: unknown[] = [];
  const handle = await rt.spawn(code, { init: baseInit(13) });
  rt.onMessage(handle, (m) => { if ((m as { __mithic_error?: unknown })?.__mithic_error != null) errors.push(m); });
  await new Promise((r) => setTimeout(r, 800));
  expect(errors.length).toBeGreaterThan(0);
  rt.dispose(handle);
}, 10000);

test('iframe OF1: malformed guest surfaces __mithic_error', async () => {
  const rt = new IframeRuntime();
  const handle = await rt.spawn('export default (', { init: baseInit(14) });
  const errors: unknown[] = [];
  rt.onMessage(handle, (m) => { if ((m as { __mithic_error?: unknown })?.__mithic_error != null) errors.push(m); });
  await new Promise((r) => setTimeout(r, 800));
  expect(errors.length).toBeGreaterThan(0);
  rt.dispose(handle);
}, 10000);

test('negative: with blob: stripped from script-src, the guest-module import is CSP-refused', async () => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'">
    </head><body><script type="module">
      window.onmessage = async () => {
        let refused = false;
        try {
          const u = URL.createObjectURL(new Blob(['export default 1'], { type: 'text/javascript' }));
          await import(u);
        } catch (_e) { refused = true; }
        window.parent.postMessage({ call: 'csp', refused }, '*');
      };
    </script></body></html>`;
  document.body.appendChild(iframe);
  await new Promise((r) => iframe.addEventListener('load', () => r(undefined), { once: true }));
  const got = await new Promise((resolve) => {
    window.addEventListener('message', function h(e) {
      if ((e.data as { call?: string })?.call === 'csp') { window.removeEventListener('message', h); resolve(e.data); }
    });
    iframe.contentWindow!.postMessage({}, '*');
  });
  expect((got as { refused: boolean }).refused).toBe(true);
  iframe.remove();
}, 10000);

test('iframe OF1: an IIFE guest (globalThis.__mithic_default, no export) still runs', async () => {
  const rt = new IframeRuntime();
  const code = /* js */`
    'use strict';
    globalThis.__mithic_default = async (boot) => {
      window.parent.postMessage({ id: 6, call: 'iife-ran', args: { pid: boot.init.pid } }, '*');
    };
  `;
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init: baseInit(16) });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 800));
  const msg = received.find((m) => (m as { call?: string })?.call === 'iife-ran') as { args: { pid: number } } | undefined;
  expect(msg?.args.pid).toBe(16);
  rt.dispose(handle);
}, 10000);

test('iframe OF1: isUrl entry with a host-minted blob: is unsupported by design — fails loud, does not run', async () => {
  // DIVERGENCE from the Worker isUrl path (worker-of1: a host-minted blob: URL DOES import,
  // because a data:-spawned Worker is transitionally same-origin to the host page). The iframe
  // is OPAQUE-origin: a host-page blob: URL is cross-origin to it, and the restrictive script-src
  // (no origin sources) has nothing to match, so `await import(hostBlobUrl)` in the bootstrap
  // throws "Failed to fetch dynamically imported module". Empirically observed (this repo's
  // Chromium, 2026-07-04): the guest NEVER runs and the bootstrap's run().catch() surfaces a
  // __mithic_error — fail-loud, not silent. This is BY DESIGN: exec-from-VFS always passes source
  // STRINGS (the in-sandbox-minting path), so iframe isUrl entry is a niche/unsupported path; this
  // test PINS that reality rather than asserting a success that does not occur.
  const rt = new IframeRuntime();
  const guestSrc = /* js */`
    export default async (boot) => {
      window.parent.postMessage({ id: 99, call: 'url-ran', args: { pid: boot.init.pid } }, '*');
    };
  `;
  const url = new URL(URL.createObjectURL(new Blob([guestSrc], { type: 'text/javascript' })));
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const handle = await rt.spawn(url, { init: baseInit(17) });
  rt.onMessage(handle, (m) => {
    received.push(m);
    if ((m as { __mithic_error?: unknown })?.__mithic_error != null) errors.push(m);
  });
  await new Promise((r) => setTimeout(r, 800));
  const ran = received.some((m) => (m as { call?: string })?.call === 'url-ran');
  expect(ran).toBe(false);
  expect(errors.length).toBeGreaterThan(0);
  rt.dispose(handle);
}, 10000);
