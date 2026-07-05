import { test, expect } from 'vitest';
import { manifestCsp } from './app-registry.ts';

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
