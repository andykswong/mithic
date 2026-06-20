/**
 * H3 — functional isolated-vm backend as a Kernel backend.
 *
 * Previously IvmRuntime.spawn awaited context.eval() to completion before
 * returning and the __mithic_syscall Callback was fire-and-forget, so no syscall
 * could ever be serviced; and there was no IvmRelayLauncher (directPipes=false
 * forces the relay path). Now:
 *   - IvmRuntime starts the isolate non-blocking with a SUSPENDABLE async syscall
 *     bridge (applySyncPromise round-trip) that returns results into the isolate.
 *   - IvmRelayLauncher mirrors the QuickJS relay launcher so a Kernel can run with
 *     IvmRuntime: the guest's __mithic_syscall(call,args) is serviced in-kernel.
 *   - cpuLimit is enforced via an isolate.cpuTime watchdog.
 *
 * Gated with isIvmAvailable(): skipped if the native addon can't load.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { isIvmAvailable, IvmRuntime } from '@mithic/runtime/backends/ivm';
import { IvmRelayLauncher } from './launchers/ivm-relay-launcher.ts';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

const ivmAvailable = await isIvmAvailable();

test.skipIf(!ivmAvailable)(
  'H3: a Kernel running IvmRuntime services a guest syscall round-trip and writes stdout',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    // The guest performs a SERVICED syscall (process/getpid) — proving the bridge
    // returns a real result into the isolate — then writes it to stdout and exits.
    // isolated-vm has Uint8Array but no TextEncoder; pass a string to pipe/write.
    const code = `
      const r = __mithic_syscall('process/getpid', {});
      __mithic_syscall('pipe/write', { fd: 1, data: 'pid=' + r.pid });
      __mithic_syscall('process/exit', { code: 0 });
    `;
    const { pid, stdout } = await kernel.spawn(code, { args: ['prog'], capabilities: [], captureStdout: true });
    const result = await kernel.wait(pid);
    expect(result.code).toBe(0);
    // The serviced getpid returned the kernel-owned pid (the bridge round-tripped).
    expect(new TextDecoder().decode(await stdout!)).toBe('pid=' + pid);
  },
  20000,
);

test.skipIf(!ivmAvailable)(
  'H3: a capability-gated fs syscall is denied in-kernel for an ivm relay guest (EACCES)',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    await vfs.mkdir('/secret');
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    const code = `
      let result;
      try { __mithic_syscall('fs/stat', { path: '/secret/k.txt' }); result = 'NO_ERROR'; }
      catch (e) { result = String((e && e.code) || '') + ':' + String((e && e.message) || e); }
      __mithic_syscall('pipe/write', { fd: 1, data: result });
      __mithic_syscall('process/exit', { code: 0 });
    `;
    const { pid, stdout } = await kernel.spawn(code, {
      args: ['prog'],
      capabilities: [{ type: 'fs', paths: ['/allowed'], operations: ['read'] }],
      captureStdout: true,
    });
    await kernel.wait(pid);
    const out = new TextDecoder().decode(await stdout!);
    expect(out).toContain('EACCES');
    expect(out).not.toContain('NO_ERROR');
  },
  20000,
);

test.skipIf(!ivmAvailable)(
  'H3: cpuLimit aborts a CPU-bound infinite loop (cpuMs enforced)',
  async () => {
    const rt = await IvmRuntime.create(64);
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());
    const kernel = new Kernel({ runtime: rt, vfs, relayLauncher: new IvmRelayLauncher(rt) });

    // A tight infinite loop that never yields — only a cpuTime watchdog stops it.
    const code = 'let x = 0; for (;;) { x++; }';
    const t0 = Date.now();
    const { pid } = await kernel.spawn(code, { args: ['spin'], capabilities: [], limits: { cpuMs: 200 } });
    const result = await Promise.race([
      kernel.wait(pid),
      new Promise<{ code: number }>((_, rej) => setTimeout(() => rej(new Error('cpuLimit watchdog never fired (H3)')), 8000)),
    ]);
    const elapsed = Date.now() - t0;
    expect(result.code).not.toBe(0); // killed (137)
    expect(elapsed).toBeLessThan(6000);
  },
  12000,
);

test('H3: IvmRuntime advertises cpuLimit + a relay launcher exists (compile-time wiring)', async () => {
  // This always runs (no native addon needed) to prove the API surface exists:
  // IvmRelayLauncher is exported and IVM_CAPABILITIES advertise the enforced limits.
  const { IVM_CAPABILITIES } = await import('@mithic/runtime');
  expect(IVM_CAPABILITIES.directPipes).toBe(false);
  expect(IVM_CAPABILITIES.memoryLimit).toBe(true);
  expect(IVM_CAPABILITIES.cpuLimit).toBe(true);
  expect(typeof IvmRelayLauncher).toBe('function');
});
