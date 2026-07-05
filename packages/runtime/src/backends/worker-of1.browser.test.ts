import { test, expect } from 'vitest';
import { WorkerRuntime } from './worker.ts';

function baseInit(pid: number) {
  return { type: 'init' as const, entry: 'inline' as const, args: ['prog'], env: {}, cwd: '/', pid, ppid: 0, capabilities: [] };
}

test('Worker OF1: an ESM guest (export default) loads via a blob: module and runs', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const code = /* js */`
    export default async (boot) => {
      boot.control.postMessage({ id: 1, call: 'ran', args: { pid: boot.init.pid, hasImports: 'imports' in boot } });
    };
  `;
  const handle = await rt.spawn(code, { init: baseInit(7), transfer: [ch.port2] });
  await new Promise((r) => setTimeout(r, 600));
  const msg = received.find((m) => (m as { call?: string })?.call === 'ran') as { args: { pid: number; hasImports: boolean } } | undefined;
  expect(msg).toBeDefined();
  expect(msg!.args.pid).toBe(7);
  expect(msg!.args.hasImports).toBe(true);
  rt.dispose(handle);
}, 10000);

test('Worker OF1: an IIFE guest (globalThis.__mithic_default, no export) still runs', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const code = /* js */`
    'use strict';
    globalThis.__mithic_default = async (boot) => {
      boot.control.postMessage({ id: 2, call: 'iife-ran', args: {} });
    };
  `;
  const handle = await rt.spawn(code, { init: baseInit(8), transfer: [ch.port2] });
  await new Promise((r) => setTimeout(r, 600));
  expect(received.some((m) => (m as { call?: string })?.call === 'iife-ran')).toBe(true);
  rt.dispose(handle);
}, 10000);

test('Worker OF1: zero-dep guest sees boot.imports as {} (present, not absent)', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const code = /* js */`
    export default async (boot) => {
      boot.control.postMessage({ id: 3, call: 'imports-shape', args: { isObj: boot.imports && typeof boot.imports === 'object', keys: Object.keys(boot.imports).length } });
    };
  `;
  const handle = await rt.spawn(code, { init: baseInit(9), transfer: [ch.port2] });
  await new Promise((r) => setTimeout(r, 600));
  const msg = received.find((m) => (m as { call?: string })?.call === 'imports-shape') as { args: { isObj: boolean; keys: number } } | undefined;
  expect(msg?.args.isObj).toBe(true);
  expect(msg?.args.keys).toBe(0);
  rt.dispose(handle);
}, 10000);

test('Worker OF1: a malformed guest (SyntaxError) surfaces __mithic_error, not silent', async () => {
  const rt = new WorkerRuntime();
  const errors: unknown[] = [];
  const code = 'export default (';
  const handle = await rt.spawn(code, { init: baseInit(10) });
  rt.onMessage(handle, (m) => { if ((m as { __mithic_error?: unknown })?.__mithic_error != null) errors.push(m); });
  await new Promise((r) => setTimeout(r, 600));
  expect(errors.length).toBeGreaterThan(0);
  rt.dispose(handle);
}, 10000);

test('Worker OF1: a dep blob is same-origin to the sandbox (blob: protocol + same-origin fetch succeeds)', async () => {
  // §8/§4.4 "Same-origin blob": the crux that lets a null-origin worker import its dep blob
  // is that the in-sandbox-minted blob is SAME-ORIGIN to the sandbox. The deterministic
  // signal: boot.imports[dep] starts with 'blob:' AND a same-origin fetch of it succeeds
  // (a cross-origin blob: fetch would reject). The worker global has no connect-src CSP, so
  // fetch of its own blob: resolves.
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const code = /* js */`
    export default async (boot) => {
      const u = boot.imports['dep'];
      const isBlob = typeof u === 'string' && u.startsWith('blob:');
      let fetchedOk = false;
      try { fetchedOk = (await fetch(u)).ok; } catch (_e) { fetchedOk = false; }
      const { hello } = await import(u);
      boot.control.postMessage({ id: 6, call: 'origin', args: { isBlob, fetchedOk, dep: hello() } });
    };
  `;
  const handle = await rt.spawn(code, { init: baseInit(12), transfer: [ch.port2], guestImports: { dep: 'export const hello = () => 7;' } });
  await new Promise((r) => setTimeout(r, 600));
  const msg = received.find((m) => (m as { call?: string })?.call === 'origin') as { args: { isBlob: boolean; fetchedOk: boolean; dep: number } } | undefined;
  expect(msg?.args.isBlob).toBe(true);
  expect(msg?.args.fetchedOk).toBe(true);
  expect(msg?.args.dep).toBe(7);
  rt.dispose(handle);
}, 10000);

test('Worker OF1: a LARGE guest (few hundred KB) imports and runs — revoke-after-import ordering', async () => {
  // §4.4/§8 "a LARGE guest imports fine". The blob-module import must complete before the
  // host revokes the guest URL — revoke is in finally AFTER import() resolves (spec §4.2
  // step 4), so a large source exercises that the import finishes before revoke (no
  // truncation). A real byte-exact marker proves the whole large module loaded and ran.
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const pad = '/* '.concat('x'.repeat(400_000), ' */');
  const code = `${pad}\nexport default async (boot) => { boot.control.postMessage({ id: 7, call: 'big-ran', args: { len: ${pad.length} } }); };`;
  const handle = await rt.spawn(code, { init: baseInit(13), transfer: [ch.port2] });
  await new Promise((r) => setTimeout(r, 800));
  const msg = received.find((m) => (m as { call?: string })?.call === 'big-ran') as { args: { len: number } } | undefined;
  expect(msg).toBeDefined();
  expect(msg!.args.len).toBeGreaterThan(400_000);
  rt.dispose(handle);
}, 15000);

test('Worker OF1: a URL-entry guest (isUrl path) imports directly without host-side re-minting', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const guestSrc = /* js */`
    export default async (boot) => {
      boot.control.postMessage({ id: 5, call: 'url-ran', args: { pid: boot.init.pid } });
    };
  `;
  const url = new URL(URL.createObjectURL(new Blob([guestSrc], { type: 'text/javascript' })));
  const handle = await rt.spawn(url, { init: baseInit(11), transfer: [ch.port2] });
  await new Promise((r) => setTimeout(r, 600));
  const msg = received.find((m) => (m as { call?: string })?.call === 'url-ran') as { args: { pid: number } } | undefined;
  expect(msg?.args.pid).toBe(11);
  rt.dispose(handle);
}, 10000);
