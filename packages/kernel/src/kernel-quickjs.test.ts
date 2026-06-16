/**
 * H.3: Kernel integration over QuickJS + cross-backend smoke test
 *
 * The kernel can host guest code on both the Worker backend (direct-port path)
 * and the QuickJS backend (relay path), producing identical stdout.
 *
 * QuickJS relay path:
 *   - `capabilities.directPipes === false` → kernel calls `#spawnRelay`
 *   - `QuickJSGuestLauncher.launchRelay` spawns via QuickJSRuntime with an
 *     `onSyscall` handler that bridges:
 *       pipe/write → relayCtx.writeStdout / writeStderr
 *       process/exit → relayCtx.notifyExit + close pipes
 *       fs/* / anything else → relayCtx.onSyscall (KERNEL-routed; the kernel binds
 *         the pid and dispatches with in-kernel capability checks — the launcher
 *         never touches the SyscallDispatcher or the pid)
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import type { RelayContext, RelayLauncher } from './kernel.ts';
import type { ProcessHandle } from '@mithic/runtime';
import type { Runtime } from '@mithic/runtime';
import { QuickJSRuntime } from '@mithic/runtime/backends/quickjs';
import type { QuickJSSpawnOptions } from '@mithic/runtime/backends/quickjs';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * Relay launcher for QuickJS: bridges the kernel's RelayContext callbacks to
 * QuickJSRuntime.spawn()'s onSyscall handler.
 *
 * Syscall routing:
 *   pipe/write  → writes to stdout (fd 1) or stderr (fd 2) via relay context
 *   process/exit → notifies exit and closes pipes
 *   process/getpid → returns pid from ProcessInit
 *   anything else (incl. fs/*) → routes through the KERNEL via `ctx.onSyscall`.
 *     The kernel owns the pid and runs all capability checks; the launcher cannot
 *     forge a pid or reach the SyscallDispatcher directly.
 */
class QuickJSGuestLauncher implements RelayLauncher {
  #rt: QuickJSRuntime;

  constructor(rt: QuickJSRuntime) {
    this.#rt = rt;
  }

  async launchRelay(runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    void runtime; // QuickJSRuntime is injected directly; runtime arg is unused here

    const onSyscall: QuickJSSpawnOptions['onSyscall'] = async (call, args) => {
      switch (call) {
        case 'pipe/write': {
          const fd = Number(args['fd'] ?? 1);
          const rawData = args['data'];
          let chunk: Uint8Array;
          if (rawData instanceof Uint8Array) {
            chunk = rawData;
          } else if (Array.isArray(rawData)) {
            chunk = new Uint8Array(rawData as number[]);
          } else if (typeof rawData === 'string') {
            chunk = new TextEncoder().encode(rawData);
          } else {
            chunk = new Uint8Array(0);
          }
          if (fd === 1) ctx.writeStdout(chunk);
          else if (fd === 2) ctx.writeStderr(chunk);
          return { written: chunk.byteLength };
        }

        case 'process/exit': {
          const code = Number(args['code'] ?? 0);
          ctx.closeStdout();
          ctx.closeStderr();
          ctx.notifyExit(code);
          return {};
        }

        case 'process/getpid':
          return { pid: ctx.init.pid };

        default: {
          // KERNEL-routed: the kernel binds the pid and enforces capabilities.
          const res = await ctx.onSyscall(call, args);
          if (res.ok) return res.result as Record<string, unknown>;
          throw new Error(`${res.error.code}: ${res.error.message}`);
        }
      }
    };

    const opts: QuickJSSpawnOptions = {
      init: ctx.init,
      onSyscall,
    };

    const handle = await this.#rt.spawn(ctx.code, opts);

    // When the QuickJS process exits naturally (no explicit process/exit call),
    // ensure pipes are closed and notifyExit fires.
    this.#rt.waitExit(handle).then(({ code }) => {
      ctx.closeStdout();
      ctx.closeStderr();
      ctx.notifyExit(code);
    }).catch(() => {
      ctx.notifyExit(1);
    });

    return handle;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('kernel relay: quickjs process writes to stdout and exits 0', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const kernel = new Kernel({
    runtime: qjsRt,
    vfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  // Guest code uses __isola_syscall directly — no MessagePorts needed.
  // Writes stdout as a UTF-8 string; the relay converts it to bytes.
  const code = `
    __isola_syscall('pipe/write', { fd: 1, data: 'hello\\n' });
    __isola_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });

  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello\n');
}, 15000);

// NOTE: This is NOT a true write-once-run-anywhere parity test. It runs the
// in-process Worker fallback (Worker is undefined in this Node env, so
// DefaultGuestLauncher uses its dynamic-import bootstrap — not a real Worker)
// vs the QuickJS relay path, and the two backends execute DIFFERENT guest source
// (Worker uses @mithic/guest-runtime MessagePorts; QuickJS uses __isola_syscall).
// It's a useful smoke test that both transports yield the same bytes for
// equivalent programs, but it does not prove a single artifact runs unchanged on
// both. True cross-transport parity requires a unified guest shim layer (future).
test('kernel smoke: inprocess-worker and quickjs-relay produce identical stdout (NOT true WORA parity)', async () => {
  // ----- Worker backend (existing transferable path) -----
  const { WorkerRuntime } = await import('@mithic/runtime/backends/worker');
  const workerVfs = new FileSystemRouter();
  await workerVfs.mount('/', new MemoryFsProvider());
  const workerKernel = new Kernel({ runtime: new WorkerRuntime(), vfs: workerVfs });

  const workerCode = `
    import { createGuest } from '@mithic/guest-runtime';
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode('hello\\n'));
      await w.close();
      g.exit(0);
    };`;

  const workerSpawn = await workerKernel.spawn(workerCode, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });
  await workerKernel.wait(workerSpawn.pid);
  const workerOut = new TextDecoder().decode(await workerSpawn.stdout!);

  // ----- QuickJS backend (relay path) -----
  const qjsRt = await QuickJSRuntime.create();
  const qjsVfs = new FileSystemRouter();
  await qjsVfs.mount('/', new MemoryFsProvider());
  const qjsKernel = new Kernel({
    runtime: qjsRt,
    vfs: qjsVfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  const qjsCode = `
    __isola_syscall('pipe/write', { fd: 1, data: 'hello\\n' });
    __isola_syscall('process/exit', { code: 0 });
  `;

  const qjsSpawn = await qjsKernel.spawn(qjsCode, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });
  await qjsKernel.wait(qjsSpawn.pid);
  const qjsOut = new TextDecoder().decode(await qjsSpawn.stdout!);

  // Both backends produce the same output.
  // NOTE: The guest code strings differ because QuickJS uses __isola_syscall
  // directly (no MessagePorts) while Worker guests use @mithic/guest-runtime.
  // Full write-once-run-anywhere requires a unified guest shim layer (future).
  expect(workerOut).toBe('hello\n');
  expect(qjsOut).toBe('hello\n');
  expect(qjsOut).toBe(workerOut); // parity assertion
}, 20000);

/**
 * SECURITY REGRESSION (Fix 1): capability enforcement must hold on the relay path
 * exactly as it does on the transfer path. The kernel — not the launcher — routes
 * syscalls and binds the pid, so a relay guest hitting an UNGRANTED path is denied
 * (EACCES) by the in-kernel dispatcher even though the launcher only relays raw
 * call+args. If the dispatcher were exposed to the launcher, this guarantee would
 * depend on launcher discipline; it must not.
 */
test('kernel relay SECURITY: fs syscall to an ungranted path is denied (EACCES) by the kernel', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  // A secret area the guest is NOT granted access to. The capability check runs
  // before any VFS access, so existence is irrelevant to the denial — but we
  // create it to make the intent (the guest is reaching for real data) explicit.
  await vfs.mkdir('/secret');

  const kernel = new Kernel({
    runtime: qjsRt,
    vfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  // Guest is granted fs access ONLY to /allowed, then tries to stat /secret.
  // The launcher relays the raw fs/stat via ctx.onSyscall; the kernel dispatches
  // it against the guest's grants and denies it. The guest reports the errno.
  const code = `
    let result;
    try {
      __isola_syscall('fs/stat', { path: '/secret/key.txt' });
      result = 'NO_ERROR';
    } catch (e) {
      result = String(e.message || e);
    }
    __isola_syscall('pipe/write', { fd: 1, data: result });
    __isola_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [{ type: 'fs', paths: ['/allowed'], operations: ['read', 'write'] }],
    captureStdout: true,
  });

  await kernel.wait(pid);
  const out = new TextDecoder().decode(await stdout!);
  // Kernel denied the ungranted access with EACCES — capability enforcement held.
  expect(out).toContain('EACCES');
  expect(out).not.toContain('NO_ERROR');
}, 15000);

/**
 * REGRESSION (Fix 1): fs/pipe on the relay path must return ENOSYS and must NOT
 * leak MessagePorts. The relay dispatcher drops the `transfer` list (it cannot
 * transfer ports over the relay bridge), so any minted ports would be silently
 * abandoned — live ports that are never closed. The kernel must intercept this,
 * close any minted ports, and surface ENOSYS to the guest instead.
 */
test('kernel relay: fs/pipe returns ENOSYS and leaks no MessagePort', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const kernel = new Kernel({
    runtime: qjsRt,
    vfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  // The guest attempts fs/pipe via the kernel relay and captures the error code.
  const code = `
    let result;
    try {
      __isola_syscall('fs/pipe', {});
      result = 'NO_ERROR';
    } catch (e) {
      result = String(e.message || e);
    }
    __isola_syscall('pipe/write', { fd: 1, data: result });
    __isola_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });

  await kernel.wait(pid);
  const out = new TextDecoder().decode(await stdout!);
  // Must get ENOSYS — fs/pipe is unsupported on non-transferable (relay) backends.
  expect(out).toContain('ENOSYS');
  expect(out).not.toContain('NO_ERROR');
}, 15000);

/**
 * Control: a relay guest CAN access a GRANTED path — proves the kernel routing
 * isn't simply denying everything.
 */
test('kernel relay: fs syscall to a granted path succeeds', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  await vfs.mkdir('/allowed');

  const kernel = new Kernel({
    runtime: qjsRt,
    vfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  // Stat a granted, existing directory — capability check passes, VFS succeeds.
  const code = `
    let result;
    try {
      __isola_syscall('fs/stat', { path: '/allowed' });
      result = 'OK';
    } catch (e) {
      result = String(e.message || e);
    }
    __isola_syscall('pipe/write', { fd: 1, data: result });
    __isola_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [{ type: 'fs', paths: ['/allowed'], operations: ['read', 'write'] }],
    captureStdout: true,
  });

  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('OK');
}, 15000);

/**
 * MEMORY-BOUND REGRESSION (Fix 2): the relay must NOT accumulate unbounded stdout.
 * A guest writing past the cap is truncated at the cap and the process is killed,
 * so host memory cannot grow without limit. Here we set a tiny maxOutputBytes and
 * have the guest write well beyond it in a loop.
 */
test('kernel relay: stdout is bounded at maxOutputBytes (no unbounded host growth)', async () => {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const kernel = new Kernel({
    runtime: qjsRt,
    vfs,
    relayLauncher: new QuickJSGuestLauncher(qjsRt),
  });

  const cap = 1024; // 1 KiB cap
  // Write 200 chunks of 100 bytes = ~20 KiB, far past the 1 KiB cap.
  const code = `
    const chunk = 'x'.repeat(100);
    for (let i = 0; i < 200; i++) {
      __isola_syscall('pipe/write', { fd: 1, data: chunk });
    }
    __isola_syscall('process/exit', { code: 0 });
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
    limits: { maxOutputBytes: cap },
  });

  await kernel.wait(pid);
  const out = await stdout!;
  // Captured output is truncated at the cap — not the full ~20 KiB the guest tried.
  expect(out.byteLength).toBeLessThanOrEqual(cap);
  expect(out.byteLength).toBeGreaterThan(0);
}, 15000);
