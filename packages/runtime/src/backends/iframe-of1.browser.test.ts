import { test, expect } from 'vitest';
import { buildSrcdoc } from './iframe-bootstrap.ts';
import { IframeRuntime } from './iframe.ts';

test('script-src gains blob: (for the guest-module import) but never data:', () => {
  const csp = buildSrcdoc().match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1];
  expect(csp).toMatch(/script-src[^;]*\bblob:/);
  expect(csp).not.toMatch(/script-src[^;]*\bdata:/);
});
