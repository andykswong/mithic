import { test, expect } from 'vitest';
import { manifestCsp, appDescriptorFromManifest } from './app-registry.ts';

test('manifestCsp: no assets → tightest passive CSP (no img/media/font src), connect none, worker-src none', () => {
  const csp = manifestCsp({ name: 'x' });
  expect(csp).toContain('default-src \'none\'');
  expect(csp).toContain('script-src \'unsafe-inline\' \'unsafe-eval\' blob:');
  expect(csp).toContain('worker-src \'none\'');
  expect(csp).toContain('connect-src \'none\'');
  expect(csp).not.toContain('img-src');
});

test('manifestCsp: assets.img → img-src blob: data: (local only), still connect none', () => {
  const csp = manifestCsp({ name: 'x', assets: { img: true } });
  expect(csp).toContain('img-src blob: data:');
  expect(csp).not.toContain('media-src');
  expect(csp).toContain('connect-src \'none\'');
});

test('manifestCsp: NEVER emits remote origins or data: in script-src', () => {
  const csp = manifestCsp({ name: 'x', assets: { img: true, media: true, font: true } });
  expect(csp).not.toMatch(/https?:/);
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  expect(csp).toMatch(/script-src[^;]*\bblob:/);
});

test('manifestCsp: a fully-enabled manifest matches the DEFAULT_GUEST_CSP directive set (parity with the static default)', () => {
  // With all passive media enabled, manifestCsp should be directive-equivalent to the runtime default.
  const csp = manifestCsp({ name: 'x', assets: { img: true, media: true, font: true } });
  for (const dir of [
    'default-src \'none\'',
    'script-src \'unsafe-inline\' \'unsafe-eval\' blob:',
    'worker-src \'none\'',
    'img-src blob: data:',
    'media-src blob: data:',
    'font-src blob: data:',
    'style-src \'unsafe-inline\'',
    'connect-src \'none\'',
    'form-action \'none\'',
    'base-uri \'none\'',
    'webrtc \'block\'',
  ]) {
    expect(csp).toContain(dir);
  }
});

test('manifestCsp: NEGATIVE guards hold across every assets combo (no remote/exfil in connect-src, worker-src/connect-src stay exactly none)', () => {
  const combos: Array<{ img?: boolean; font?: boolean; media?: boolean }> = [
    {},
    { img: true },
    { font: true },
    { media: true },
    { img: true, font: true, media: true },
  ];
  for (const assets of combos) {
    const csp = manifestCsp({ name: 'x', assets });
    // No remote origin ANYWHERE, no data: in script-src, no blob:/data:/remote in connect-src.
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toMatch(/script-src[^;]*data:/);
    expect(csp).not.toMatch(/connect-src[^;]*(blob:|data:|https?:)/);
    // connect-src and worker-src are EXACTLY 'none' (network is net/fetch; no nested workers).
    expect(csp).toMatch(/connect-src 'none'(;|$)/);
    expect(csp).toMatch(/worker-src 'none'(;|$)/);
  }
});

test('appDescriptorFromManifest populates csp from manifestCsp (WM threads it at spawn)', () => {
  // No assets → tightest CSP (no img-src) → the guest genuinely cannot render images.
  const bare = appDescriptorFromManifest({ name: 'headless' }, { entry: 'CODE;' });
  expect(bare.csp).toBe(manifestCsp({ name: 'headless' }));
  expect(bare.csp).not.toContain('img-src');
  // assets.img opts in → img-src blob: data: appears in the compiled descriptor CSP.
  const viewer = appDescriptorFromManifest(
    { name: 'viewer', assets: { img: true } },
    { entry: 'CODE;' },
  );
  expect(viewer.csp).toBe(manifestCsp({ name: 'viewer', assets: { img: true } }));
  expect(viewer.csp).toContain('img-src blob: data:');
});
