/**
 * K3 — dom/event host→guest forwarding.
 *
 * Same root cause as C1: the kernel never posted KernelEvents to guests, so the
 * Remote-DOM loop was one-directional (guest→host mutations only). The kernel now
 * exposes `Kernel.forwardDomEvent(pid, payload)`, which posts a
 * `{event:'dom/event', payload}` KernelEvent over the pid's retained control port.
 * The guest's `onDomEvent` consumer (guest.ts) dispatches it to the matching VNode
 * listener. The RemoteDomHost captures a real DOM event and the host wires its
 * `onGuestEvent` callback to `forwardDomEvent`.
 *
 * This is a node-level test of the forwarding PATH: it spawns a guest that wires
 * onDomEvent to write the received event to stdout, posts a synthetic event from
 * the kernel, and asserts the guest received it.
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

test('K3: a host-forwarded dom/event reaches the guest onDomEvent handler', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // The guest installs onDomEvent; when it receives a click on node 7 it writes
  // the serialized event to stdout and exits. Proves host→guest delivery works.
  const code = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      g.onDomEvent(async (ev) => {
        await w.write(new TextEncoder().encode(JSON.stringify(ev)));
        await w.close();
        g.exit(0);
      });
      await new Promise(() => {}); // park until the event arrives
    };`;
  const { pid, stdout } = await kernel.spawn(code, {
    args: ['ui'],
    capabilities: [],
    captureStdout: true,
  });

  // Let the guest wire its onDomEvent handler before the kernel posts the event.
  await new Promise((r) => setTimeout(r, 200));
  kernel.forwardDomEvent(pid, { nodeId: 7, eventType: 'click', payload: { x: 1 } });

  const result = await withTimeout(kernel.wait(pid), 6000, 'guest never received dom/event (K3)');
  expect(result.code).toBe(0);
  const received = JSON.parse(new TextDecoder().decode(await stdout!)) as {
    nodeId: number; eventType: string; payload: Record<string, unknown>;
  };
  expect(received.nodeId).toBe(7);
  expect(received.eventType).toBe('click');
  expect(received.payload).toEqual({ x: 1 });
}, 12000);

test('K3: forwardDomEvent to an exited/unknown pid is a safe no-op', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  // No process with pid 999 — must not throw.
  expect(() => kernel.forwardDomEvent(999, { nodeId: 1, eventType: 'click' })).not.toThrow();
});
