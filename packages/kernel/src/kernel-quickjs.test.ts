/**
 * H.3: Kernel integration over QuickJS + cross-backend parity
 *
 * Validates Open Question 9 (write-once-run-anywhere): the kernel can host guest
 * code on both the Worker backend (direct-port path) and the QuickJS backend
 * (relay path), producing identical stdout.
 *
 * QuickJS relay path:
 *   - `capabilities.directPipes === false` → kernel calls `#spawnRelay`
 *   - `QuickJSGuestLauncher.launchRelay` spawns via QuickJSRuntime with an
 *     `onSyscall` handler that bridges:
 *       pipe/write → relayCtx.writeStdout / writeStderr
 *       process/exit → relayCtx.notifyExit + close pipes
 *       fs/* → relayCtx.dispatcher
 *
 * Parity note:
 *   Worker guest code uses the `@mithic/guest-runtime` MessagePort API.
 *   QuickJS guest code calls `__isola_syscall` directly (no MessagePort).
 *   Both produce identical stdout output, validating the relay path correctness.
 *   Full write-once-run-anywhere requires a unified shim layer (future work).
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
 *   fs/*        → routes through kernel's SyscallDispatcher
 *   anything else → returns {} (ENOSYS at the guest level)
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

        default:
          if (call.startsWith('fs/')) {
            const res = await ctx.dispatcher.dispatch(ctx.init.pid, {
              id: 0,
              call,
              args,
            });
            if (res.ok) return res.result as Record<string, unknown>;
            throw new Error(res.error.message);
          }
          return {};
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

test('kernel parity: worker and quickjs produce identical stdout', async () => {
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
