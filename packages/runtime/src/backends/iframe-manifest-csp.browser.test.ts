import { test, expect } from 'vitest';
import { buildSrcdoc, DEFAULT_GUEST_CSP } from './iframe-bootstrap.ts';
import { IframeRuntime } from './iframe.ts';

/**
 * Byte-for-byte mirror of @mithic/desktop's manifestCsp (packages/desktop/src/app-registry.ts,
 * pinned by manifest-csp.test.ts). Reproduced here rather than imported because desktop sits
 * ABOVE runtime in the layering — a runtime→desktop import (package OR relative source) would
 * invert the dependency graph AND trip the runtime tsconfig's rootDir (src-only) constraint.
 * The E2E below therefore exercises the exact compiled-CSP STRING a manifest yields, not the
 * function object; if the desktop compiler ever changes, F2's parity test catches the drift.
 */
function manifestCsp(manifest: { name: string; assets?: { img?: boolean; font?: boolean; media?: boolean } }): string {
  const dirs = [
    'default-src \'none\'',
    'script-src \'unsafe-inline\' \'unsafe-eval\' blob:',
    'worker-src \'none\'',
    'style-src \'unsafe-inline\'',
  ];
  const a = manifest.assets ?? {};
  if (a.img) dirs.push('img-src blob: data:');
  if (a.media) dirs.push('media-src blob: data:');
  if (a.font) dirs.push('font-src blob: data:');
  dirs.push('connect-src \'none\'', 'form-action \'none\'', 'base-uri \'none\'', 'webrtc \'block\'');
  return dirs.join('; ');
}

test('buildSrcdoc(csp) uses the supplied CSP verbatim; default when omitted', () => {
  const custom = 'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src \'none\'; style-src \'unsafe-inline\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; webrtc \'block\'';
  expect(buildSrcdoc(custom)).toContain(`content="${custom}"`);
  // Default keeps the Task-A passive-asset CSP AND worker-src 'none' (Group D).
  expect(buildSrcdoc()).toContain('img-src blob: data:');
  expect(buildSrcdoc()).toContain('worker-src \'none\'');
  expect(DEFAULT_GUEST_CSP).toContain('worker-src \'none\'');
  expect(DEFAULT_GUEST_CSP).toMatch(/script-src[^;]*\bblob:/);
});

test('buildSrcdoc throws (fail-loud) on a csp containing a double-quote, < or > (no meta-attr breakout)', () => {
  // manifestCsp never emits these, so this is belt-and-suspenders: a malformed compiled
  // CSP must not be interpolated raw into content="${csp}" and break out of the meta tag.
  expect(() => buildSrcdoc('default-src \'none\'; report-uri "x"')).toThrow();
  expect(() => buildSrcdoc('default-src \'none\'; <script>')).toThrow();
  expect(() => buildSrcdoc('default-src \'none\'>')).toThrow();
  // A well-formed CSP (single-quoted tokens only, no double-quote/</>) does NOT throw.
  expect(() => buildSrcdoc(DEFAULT_GUEST_CSP)).not.toThrow();
});

test('a guest spawned with a manifest-compiled CSP (assets.img) can render a blob: image', async () => {
  const rt = new IframeRuntime();
  const csp = manifestCsp({ name: 'viewer', assets: { img: true } });
  const code = /* js */`
    export default async (_boot) => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const img = document.createElement('img');
      img.onload = () => window.parent.postMessage({ call: 'ok', painted: img.naturalWidth > 0 }, '*');
      img.onerror = () => window.parent.postMessage({ call: 'ok', painted: false }, '*');
      document.body.appendChild(img);
      img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    };
  `;
  const init = { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] };
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init, csp });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 800));
  expect((received.find((m) => (m as { call?: string })?.call === 'ok') as { painted: boolean })?.painted).toBe(true);
  rt.dispose(handle);
}, 10000);

test('a guest with NO assets in its manifest cannot render an image — img-src absent fires a CSP violation', async () => {
  // CSP-SPECIFIC (mirrors the Group A connect-src negative): a bare "did not paint"
  // is unsound (any load failure yields painted:false). We assert the REAL control —
  // a `securitypolicyviolation` whose directive is img-src/default-src — so this flips
  // to a failure the moment img-src is (wrongly) opened for a no-assets manifest.
  const rt = new IframeRuntime();
  const csp = manifestCsp({ name: 'headless' });
  const code = /* js */`
    export default async (_boot) => {
      let blocked = false, painted = false;
      document.addEventListener('securitypolicyviolation', (e) => {
        if (/img-src|default-src/.test(e.violatedDirective)) blocked = true;
      });
      const img = document.createElement('img');
      img.onload = () => { painted = true; };
      img.onerror = () => { /* CSP-blocked load surfaces here + as a violation */ };
      document.body.appendChild(img);
      img.src = URL.createObjectURL(new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c=>c.charCodeAt(0))], { type: 'image/png' }));
      setTimeout(() => window.parent.postMessage({ call: 'ok', blocked, painted }, '*'), 500);
    };
  `;
  const init = { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [] };
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init, csp });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 900));
  const msg = received.find((m) => (m as { call?: string })?.call === 'ok') as { blocked: boolean; painted: boolean } | undefined;
  // The image was CSP-refused: a violation fired and it never painted.
  expect(msg?.blocked).toBe(true);
  expect(msg?.painted).toBe(false);
  rt.dispose(handle);
}, 10000);
