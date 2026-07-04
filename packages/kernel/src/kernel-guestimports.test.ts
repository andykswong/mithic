import { test, expect } from 'vitest';
import { Kernel } from './kernel.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { Runtime, ProcessHandle, SpawnOptions } from '@mithic/runtime';
import { WORKER_CAPABILITIES } from '@mithic/runtime';
import type { GuestLauncher, LaunchContext } from './kernel.ts';

test('kernel builds LaunchContext.guestImports from KernelOptions.guestImports', async () => {
  let ctx: LaunchContext | undefined;
  const launcher: GuestLauncher = { async launch(_rt, c) { ctx = c; return { id: c.init.pid }; } };
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const deps = { '@mithic/guest-runtime': 'export const createGuest = () => ({});' };
  const spy: Runtime = { capabilities: WORKER_CAPABILITIES, async spawn() { return { id: 1 }; }, kill() {}, postMessage() {}, onMessage() {}, isAlive() { return true; }, dispose() {} };
  const kernel = new Kernel({ runtime: spy, vfs, guestImports: deps, launcher });
  await kernel.spawn('globalThis.__mithic_default = () => {};', { args: ['p'], capabilities: [] });
  expect(ctx?.guestImports).toEqual(deps);
});
