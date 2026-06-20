/**
 * C1 — Kernel signal delivery + 128+N exit-code semantics.
 *
 * The kernel must POST a `{event:'signal', payload:{signal}}` KernelEvent over
 * the target pid's retained control port for DELIVERABLE signals (SIGTERM/SIGINT/
 * SIGUSR1/2/etc.). The guest consumer (`guest.ts` onSignal) already exists; this
 * exercises the missing PRODUCER.
 *
 * Exit-code semantics mirror the WASM reference (manager/simple.ts:130-137):
 *   - a process terminated by signal N exits 128+N (SIGTERM=143, SIGKILL=137).
 *   - a graceful SIGTERM handler that exits cleanly reports its OWN exit code.
 *   - SIGKILL is a hard sandbox teardown with NO event delivery (137).
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/** Reject after `ms` so a hung promise fails fast instead of timing out the runner. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

test('C1: a guest that handles SIGTERM and exits 0 reports exit 0 (graceful)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // The guest installs onSignal; on SIGTERM it exits cleanly with code 0.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      g.onSignal((sig) => { if (sig === 'SIGTERM') g.exit(0); });
      await new Promise(() => {}); // park until signalled
    };`;
  const { pid } = await kernel.spawn(code, { args: ['trapper'], capabilities: [] });

  // Give the guest a moment to wire its onSignal handler before signalling.
  await new Promise((r) => setTimeout(r, 200));
  kernel.kill(pid, 'SIGTERM');

  const result = await withTimeout(kernel.wait(pid), 6000, 'graceful SIGTERM never settled (C1)');
  expect(result.code).toBe(0);
}, 12000);

test('C1: an UNHANDLED SIGTERM terminates the process with exit 128+15=143', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  // Short grace window so the test is quick.
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, signalGraceMs: 150 });

  // The guest never installs an onSignal handler and never exits.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      createGuest(boot);
      await new Promise(() => {}); // never resolves; ignores signals
    };`;
  const { pid } = await kernel.spawn(code, { args: ['ignorer'], capabilities: [] });

  await new Promise((r) => setTimeout(r, 100));
  kernel.kill(pid, 'SIGTERM');

  const result = await withTimeout(kernel.wait(pid), 6000, 'unhandled SIGTERM never settled (C1)');
  // 128 + SIGTERM(15) = 143
  expect(result.code).toBe(143);
}, 12000);

test('C1: SIGKILL is a hard teardown with exit 137 (no event delivery)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // The guest WOULD exit 0 if it saw a signal, but SIGKILL is never delivered.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      g.onSignal(() => g.exit(0));
      await new Promise(() => {});
    };`;
  const { pid } = await kernel.spawn(code, { args: ['victim'], capabilities: [] });

  await new Promise((r) => setTimeout(r, 100));
  kernel.kill(pid, 'SIGKILL');

  const result = await withTimeout(kernel.wait(pid), 6000, 'SIGKILL never settled (C1)');
  // SIGKILL = 128 + 9 = 137; never the graceful 0 (the event was not delivered).
  expect(result.code).toBe(137);
}, 12000);

test('C1: an unhandled SIGINT yields 128+2=130', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, signalGraceMs: 150 });

  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      createGuest(boot);
      await new Promise(() => {});
    };`;
  const { pid } = await kernel.spawn(code, { args: ['ignorer'], capabilities: [] });

  await new Promise((r) => setTimeout(r, 100));
  kernel.kill(pid, 'SIGINT');

  const result = await withTimeout(kernel.wait(pid), 6000, 'unhandled SIGINT never settled (C1)');
  expect(result.code).toBe(130); // 128 + 2
}, 12000);

test('C1: a non-terminating signal (SIGUSR1) is delivered WITHOUT tearing the process down', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // On SIGUSR1 the guest writes a marker and exits 0 ON ITS OWN — proving the
  // signal was DELIVERED (not a teardown) and the process controls its own exit.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      g.onSignal(async (sig) => {
        if (sig === 'SIGUSR1') {
          await w.write(new TextEncoder().encode('got-usr1'));
          await w.close();
          g.exit(0);
        }
      });
      await new Promise(() => {});
    };`;
  const { pid, stdout } = await kernel.spawn(code, {
    args: ['usr'],
    capabilities: [],
    captureStdout: true,
  });

  await new Promise((r) => setTimeout(r, 200));
  kernel.kill(pid, 'SIGUSR1');

  const result = await withTimeout(kernel.wait(pid), 6000, 'SIGUSR1 delivery never settled (C1)');
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toContain('got-usr1');
}, 12000);
