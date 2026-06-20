/**
 * Cross-package composition smoke test: @mithic/guest-runtime × @mithic/runtime
 *
 * APPROACH: In-process with real createGuest.
 *
 * We construct the `boot` object exactly as WorkerRuntime's BOOTSTRAP_SOURCE does
 * (documented in packages/runtime/src/backends/worker.ts):
 *
 *   ports = [controlPort, stdinPort, stdoutPort, stderrPort, ...]
 *   preopenPorts = { 0: ports[1], 1: ports[2], 2: ports[3] }   // non-null only
 *   boot = { control: ports[0], init: ProcessInit, preopenPorts }
 *
 * We do NOT spawn a real Worker (which would require a build artifact for the guest
 * module). Instead the guest function runs in-process — the same function a Worker
 * would execute after calling `createGuest(boot)`. This exercises the full
 * guest↔kernel message shape and proves no impedance mismatch.
 *
 * Why in-process rather than a real Worker:
 *   - In the vitest node env, the guest module cannot be imported via a Worker without
 *     a pre-built dist/ artifact (Worker threads require a file URL or data URL with
 *     full ESM resolution). Running in-process with real MessageChannel ports gives
 *     identical protocol fidelity at zero build-time cost.
 *   - We import BOOTSTRAP_SOURCE from @mithic/runtime/backends/worker to assert our
 *     boot construction matches the bootstrap script's documented shape.
 */
import { expect, test } from 'vitest';
import { BOOTSTRAP_SOURCE } from '@mithic/runtime/backends/worker';
import type { ProcessInit } from '@mithic/protocol';
import { createGuest } from './guest.ts';
import { portToReadable } from './streams.ts';

/**
 * Build the boot object the same way BOOTSTRAP_SOURCE does:
 *   ports[0] = controlPort, ports[1..] = preopen pipe ports (stdin/stdout/stderr)
 */
function buildBoot(ports: (MessagePort | null)[], init: ProcessInit) {
  const preopenPorts: Record<number, MessagePort> = {};
  for (let i = 1; i < ports.length; i++) {
    if (ports[i] != null) preopenPorts[i - 1] = ports[i]!;
  }
  return { control: ports[0]!, init, preopenPorts };
}

test('BOOTSTRAP_SOURCE shape matches buildBoot construction', () => {
  // Confirm the boot object construction is consistent with the bootstrap source.
  // K2: the bootstrap now maps each stdio port to its preopen fd via a preopenFds
  // table (falling back to positional `i - 1` when absent), so we assert the stable
  // shape tokens rather than the exact (now fd-aware) mapping expression.
  expect(BOOTSTRAP_SOURCE).toContain('preopenPorts');
  expect(BOOTSTRAP_SOURCE).toContain('ports[i]');
  expect(BOOTSTRAP_SOURCE).toContain('control: ports[0]');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_init');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_default');
});

test('guest syscall+stdout composition: createGuest wired via WorkerRuntime boot shape', async () => {
  // --- Infrastructure setup ---
  // Control channel: kernel-side port drives syscall protocol.
  const controlCh = new MessageChannel();
  const kernelControlPort = controlCh.port1; // kernel holds this
  const guestControlPort = controlCh.port2;  // guest holds this (in boot.control)

  // Stdout channel: kernel side reads guest stdout output.
  const stdoutCh = new MessageChannel();
  const kernelStdoutPort = stdoutCh.port1; // kernel reads from here
  const guestStdoutPort = stdoutCh.port2;  // guest writes to here (preopenPorts[1])

  const init: ProcessInit = {
    type: 'init',
    entry: 'inline',
    args: ['prog'],
    env: {},
    cwd: '/',
    pid: 7,
    ppid: 0,
    capabilities: [],
  };

  // Build boot exactly as BOOTSTRAP_SOURCE does:
  // ports = [controlPort, stdinPort, stdoutPort, stderrPort]
  // We pass null for stdin/stderr since the guest doesn't use them.
  const boot = buildBoot([guestControlPort, null, guestStdoutPort, null], init);

  // --- Kernel side: respond to syscall requests ---
  // Wire the kernel control port: when a syscall request arrives (shape: {id, call, args}),
  // reply with a SyscallResponse ({id, ok, result}).
  kernelControlPort.start?.();
  kernelControlPort.onmessage = (e) => {
    const msg = e.data as { id?: number; type?: string; call?: string };
    if (msg.id != null && msg.type == null) {
      // This is a syscall request (has id, has call, no type field per protocol).
      if (msg.call === 'process/getpid') {
        kernelControlPort.postMessage({ id: msg.id, ok: true, result: { pid: init.pid } });
      }
    }
    // Ignore exit messages and other kernel events.
  };

  // --- Kernel side: read guest stdout via pipe protocol ---
  // Wrap the kernel's stdout port as a ReadableStream (this also grants credit).
  const stdoutReadable = portToReadable(kernelStdoutPort);
  const stdoutReader = stdoutReadable.getReader();

  // --- Guest function: mirrors what a Worker's default export would do ---
  // This is the exact code that would run in a Worker after createGuest(boot).
  const guestMain = async (b: typeof boot) => {
    const g = createGuest(b);
    const r = await g.syscall('process/getpid', {}) as { pid: number };
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode(`pid=${r.pid}`));
    await w.close();
    g.exit(0);
  };

  // Run guest in-process (same semantics as Worker calling default export).
  await guestMain(boot);

  // --- Assert: collect stdout output ---
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await stdoutReader.read();
    if (done) break;
    chunks.push(value);
  }

  const output = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.byteLength + c.byteLength);
      merged.set(acc);
      merged.set(c, acc.byteLength);
      return merged;
    }, new Uint8Array(0))
  );

  // The guest wrote "pid=<init.pid>" — assert it matches.
  expect(output).toBe(`pid=${init.pid}`);

  kernelControlPort.close();
});

test('guest exit posts {type:"exit",code} observable on kernel control port', async () => {
  const controlCh = new MessageChannel();
  const kernelControlPort = controlCh.port1;
  const guestControlPort = controlCh.port2;

  const init: ProcessInit = {
    type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 3, ppid: 0, capabilities: [],
  };

  const boot = buildBoot([guestControlPort, null, null, null], init);

  const exitMessages: unknown[] = [];
  kernelControlPort.start?.();
  kernelControlPort.onmessage = (e) => {
    const msg = e.data as { type?: string };
    if (msg.type === 'exit') exitMessages.push(msg);
  };

  const g = createGuest(boot);
  g.exit(2);

  await new Promise(r => setTimeout(r, 20));

  expect(exitMessages).toContainEqual({ type: 'exit', code: 2 });
  kernelControlPort.close();
});
