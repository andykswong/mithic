import { test, expect } from 'vitest';
import { Kernel } from './kernel.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { Runtime } from '@mithic/runtime';
import { WORKER_CAPABILITIES } from '@mithic/runtime';
import type { GuestLauncher, LaunchContext } from './kernel.ts';

test('kernel threads SpawnInit.csp into LaunchContext.csp', async () => {
  let ctx: LaunchContext | undefined;
  const launcher: GuestLauncher = { async launch(_rt, c) { ctx = c; return { id: c.init.pid }; } };
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const spy: Runtime = { capabilities: WORKER_CAPABILITIES, async spawn() { return { id: 1 }; }, kill() {}, postMessage() {}, onMessage() {}, isAlive() { return true; }, dispose() {} };
  const kernel = new Kernel({ runtime: spy, vfs, launcher });
  const csp = 'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src \'none\'; connect-src \'none\'';
  await kernel.spawn('globalThis.__mithic_default = () => {};', { args: ['p'], capabilities: [], csp });
  expect(ctx?.csp).toBe(csp);
});

test('kernel omits csp when SpawnInit.csp is absent (iframe falls back to DEFAULT_GUEST_CSP)', async () => {
  let ctx: LaunchContext | undefined;
  const launcher: GuestLauncher = { async launch(_rt, c) { ctx = c; return { id: c.init.pid }; } };
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const spy: Runtime = { capabilities: WORKER_CAPABILITIES, async spawn() { return { id: 1 }; }, kill() {}, postMessage() {}, onMessage() {}, isAlive() { return true; }, dispose() {} };
  const kernel = new Kernel({ runtime: spy, vfs, launcher });
  await kernel.spawn('globalThis.__mithic_default = () => {};', { args: ['p'], capabilities: [] });
  expect(ctx?.csp).toBeUndefined();
});

test('DefaultGuestLauncher forwards ctx.csp into runtime.spawn options', async () => {
  // Force the DefaultGuestLauncher's runtime.spawn branch (Node has no Worker
  // global, so it would otherwise take the in-process path) by stubbing Worker.
  const hadWorker = 'Worker' in globalThis;
  const prevWorker = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = function () {} as unknown;
  try {
    let spawnOpts: Record<string, unknown> | undefined;
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const spy: Runtime = {
      capabilities: WORKER_CAPABILITIES,
      async spawn(_code, opts) { spawnOpts = opts as unknown as Record<string, unknown>; return { id: 1 }; },
      kill() {}, postMessage() {}, onMessage() {}, isAlive() { return true; }, dispose() {},
    };
    const kernel = new Kernel({ runtime: spy, vfs });
    const csp = 'default-src \'none\'; connect-src \'none\'';
    await kernel.spawn('globalThis.__mithic_default = () => {};', { args: ['p'], capabilities: [], csp });
    expect(spawnOpts?.csp).toBe(csp);
  } finally {
    if (hadWorker) (globalThis as { Worker?: unknown }).Worker = prevWorker;
    else delete (globalThis as { Worker?: unknown }).Worker;
  }
});
