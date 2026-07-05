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
