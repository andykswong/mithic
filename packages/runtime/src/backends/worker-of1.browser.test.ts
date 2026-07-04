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
