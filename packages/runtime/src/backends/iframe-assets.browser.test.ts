import { test, expect } from 'vitest';
import { buildSrcdoc } from './iframe-bootstrap.ts';
import { IframeRuntime } from './iframe.ts';

// A2/A3 add runtime paint + negative tests; A1 pins the policy string itself.
test('buildSrcdoc CSP: passive blob:/data: on img/font/media, egress locked', () => {
  const html = buildSrcdoc();
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain('img-src blob: data:');
  expect(csp).toContain('media-src blob: data:');
  expect(csp).toContain('font-src blob: data:');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("webrtc 'block'");
  // script-src must NOT gain data: (ever) and must NOT yet gain blob: (that is Task Group D).
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  expect(csp).not.toMatch(/script-src[^;]*blob:/);
  expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
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
