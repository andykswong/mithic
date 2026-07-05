import { test, expect } from 'vitest';
import { buildSrcdoc, DEFAULT_GUEST_CSP } from './iframe-bootstrap.ts';

test('buildSrcdoc(csp) uses the supplied CSP verbatim; default when omitted', () => {
  const custom = 'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src \'none\'; style-src \'unsafe-inline\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; webrtc \'block\'';
  expect(buildSrcdoc(custom)).toContain(`content="${custom}"`);
  // Default keeps the Task-A passive-asset CSP AND worker-src 'none' (Group D).
  expect(buildSrcdoc()).toContain('img-src blob: data:');
  expect(buildSrcdoc()).toContain('worker-src \'none\'');
  expect(DEFAULT_GUEST_CSP).toContain('worker-src \'none\'');
  expect(DEFAULT_GUEST_CSP).toMatch(/script-src[^;]*\bblob:/);
});
