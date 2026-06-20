/**
 * Seam 1 (C1 ↔ M16): kernel-delivered signal → shell trap dispatch, end-to-end.
 *
 * The kernel posts `{event:'signal', payload:{signal}}` over a pid's retained
 * control port (Kernel.kill); the guest API surfaces it via `onSignal`. The shell
 * built `Executor.runTrap` + trap registration but never wired the two together.
 * `packages/shell/src/process.ts` now registers
 * `guest.onSignal((sig) => executor.runTrap(normalize(sig)))`.
 *
 * These tests boot a REAL Kernel + WorkerRuntime and spawn the built shell
 * `dist/process.js`, then:
 *   - register `trap 'echo caught' INT`, have the kernel deliver SIGINT while the
 *     shell is alive (blocked in a child), and assert `caught` is emitted AND the
 *     shell keeps running (the trap fired, the process was NOT torn down), then
 *     exits 0 normally; and
 *   - confirm `trap '...' EXIT` fires on normal completion.
 *
 * REQUIRES `npm run build` first (the shell guest is the built dist module).
 */
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/** Reject after `ms` so a hung promise fails fast instead of timing out the runner. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

const shellUrl = new URL('../dist/process.js', import.meta.url);

/**
 * An external command (inline guest) that sleeps `ms` then exits 0, writing
 * nothing. The shell spawns it and BLOCKS in the `process/pipeline` syscall while
 * it runs — keeping the shell process alive so a delivered signal can fire its
 * trap concurrently.
 */
function sleepGuest(ms: number): string {
  return `import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      await new Promise((r) => setTimeout(r, ${ms}));
      // Close stdout so the kernel-owned capture pipe sees EOF and the shell's
      // pipeline syscall resolves (this child writes nothing).
      await g.stdout.close().catch(() => {});
      g.exit(0);
    };`;
}

async function bootKernel(): Promise<Kernel> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) => (name === 'sleep300' ? sleepGuest(300) : undefined),
  });
}

test('Seam 1: a delivered SIGINT fires the shell INT trap and the shell keeps running', async () => {
  const kernel = await bootKernel();

  // The shell registers an INT trap, then spawns `sleep300` (a 300ms child) so it
  // stays alive long enough to receive a signal. When SIGINT lands mid-sleep the
  // trap prints `caught`; the child then finishes and the script prints `done`.
  // If the signal had TERMINATED the shell, `done` would never print.
  const script = 'trap \'echo caught\' INT; sleep300; echo done';
  const { pid, stdout } = await kernel.spawn(shellUrl, {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });

  // Wait for the trap to be registered + the child to be spawned, then signal.
  await new Promise((r) => setTimeout(r, 120));
  kernel.kill(pid, 'SIGINT');

  const { code } = await withTimeout(kernel.wait(pid), 6000, 'shell never settled after SIGINT (Seam 1)');
  const out = new TextDecoder().decode(await stdout!);

  expect(out).toContain('caught'); // the INT trap fired
  expect(out).toContain('done');   // the shell survived the signal and ran to completion
  expect(code).toBe(0);            // graceful exit, NOT 128+2
}, 12000);

test('Seam 1: an EXIT trap fires on normal completion', async () => {
  const kernel = await bootKernel();
  const { pid, stdout } = await kernel.spawn(shellUrl, {
    args: ['bash', '-c', 'trap \'echo bye\' EXIT; echo hello'],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  const { code } = await withTimeout(kernel.wait(pid), 6000, 'EXIT-trap shell never settled (Seam 1)');
  const out = new TextDecoder().decode(await stdout!);
  expect(out).toBe('hello\nbye\n');
  expect(code).toBe(0);
}, 12000);

test('Seam 1: SIGTERM with a TERM trap fires the handler instead of terminating', async () => {
  const kernel = await bootKernel();
  const script = 'trap \'echo terminated\' TERM; sleep300; echo finished';
  const { pid, stdout } = await kernel.spawn(shellUrl, {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  await new Promise((r) => setTimeout(r, 120));
  kernel.kill(pid, 'SIGTERM');
  const { code } = await withTimeout(kernel.wait(pid), 6000, 'shell never settled after SIGTERM (Seam 1)');
  const out = new TextDecoder().decode(await stdout!);
  expect(out).toContain('terminated');
  expect(out).toContain('finished');
  expect(code).toBe(0);
}, 12000);
