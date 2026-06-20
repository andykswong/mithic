/**
 * K4 (§8.2) — Heartbeat/health watchdog.
 *
 * The design specifies a liveness protocol over the control port:
 *   - Kernel posts `{event:'heartbeat'}` every `intervalMs`.
 *   - The process must reply `{type:'heartbeat-ack'}`.
 *   - After `maxMissed` consecutive missed acks the process is declared HUNG and
 *     SIGKILLed (exit 137).
 *
 * It is OPT-IN (KernelOptions.heartbeat) so existing tests do not flake — unset
 * means no heartbeat monitoring at all.
 *
 * These tests drive the kernel's control-port heartbeat contract directly: the
 * guest taps `boot.control` so the test exercises the kernel PRODUCER (ping +
 * miss-counting + kill) without depending on guest-runtime changes.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

test('K4: an unresponsive guest (never acks heartbeats) is declared hung and killed (137)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  // Fast heartbeat so the test is quick: ping every 60ms, kill after 3 misses (~240ms).
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    heartbeat: { intervalMs: 60, maxMissed: 3 },
  });

  // The guest taps boot.control but NEVER replies to heartbeat pings — it is
  // "alive" (event loop running) but unresponsive, exactly the hang the watchdog
  // must catch. It also never exits on its own.
  const code = `
    export default async (boot) => {
      boot.control.start?.();
      boot.control.onmessage = () => { /* ignore heartbeats — unresponsive */ };
      await new Promise(() => {});
    };`;
  const t0 = Date.now();
  const { pid } = await kernel.spawn(code, { args: ['hung'], capabilities: [] });

  const result = await withTimeout(kernel.wait(pid), 5000, 'heartbeat watchdog never fired (K4)');
  const elapsed = Date.now() - t0;
  // Declared hung → SIGKILL → 137.
  expect(result.code).toBe(137);
  // Fired in a bounded time tied to interval*maxMissed, not the test deadline.
  expect(elapsed).toBeLessThan(3000);
}, 10000);

test('K4: a responsive guest (acks heartbeats) is NOT killed and exits on its own', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    heartbeat: { intervalMs: 40, maxMissed: 3 },
  });

  // The guest replies to every heartbeat with {type:'heartbeat-ack'} and exits 0
  // after a window that spans several heartbeat intervals (so a broken watchdog
  // would have killed it as "hung" before it could exit).
  const code = `
    export default async (boot) => {
      boot.control.start?.();
      boot.control.onmessage = (e) => {
        if (e.data && e.data.event === 'heartbeat') {
          boot.control.postMessage({ type: 'heartbeat-ack' });
        }
      };
      await new Promise((r) => setTimeout(r, 400)); // ~10 heartbeat intervals
      boot.control.postMessage({ type: 'exit', code: 0 });
    };`;
  const { pid } = await kernel.spawn(code, { args: ['alive'], capabilities: [] });

  const result = await withTimeout(kernel.wait(pid), 5000, 'responsive guest never settled (K4)');
  // Exited 0 on its own — the watchdog must NOT have killed it (would be 137).
  expect(result.code).toBe(0);
}, 10000);

test('K4: with heartbeat unset, an unresponsive guest is left alone (opt-in)', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  // No heartbeat config → no monitoring. A timeout bound it via limits.timeoutMs.
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  const code = `
    export default async (boot) => {
      boot.control.start?.();
      boot.control.onmessage = () => {};
      await new Promise((r) => setTimeout(r, 250));
      boot.control.postMessage({ type: 'exit', code: 0 });
    };`;
  const { pid } = await kernel.spawn(code, { args: ['nomon'], capabilities: [] });

  const result = await withTimeout(kernel.wait(pid), 5000, 'unmonitored guest never settled (K4)');
  // No heartbeat monitoring → the guest is never declared hung; it exits 0 itself.
  expect(result.code).toBe(0);
}, 10000);
