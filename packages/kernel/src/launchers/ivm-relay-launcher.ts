/**
 * H3: relay launcher for the isolated-vm backend — mirrors the QuickJS relay
 * launcher so a {@link Kernel} can run with `IvmRuntime` (`directPipes === false`).
 *
 * Lives in `@mithic/kernel` (not `@mithic/runtime`) because the
 * {@link RelayLauncher}/{@link RelayContext} types are kernel-owned and the
 * runtime package must not depend on the kernel (that would be a dependency
 * cycle — `@mithic/kernel` already depends on `@mithic/runtime`).
 *
 * The kernel's {@link RelayContext} callbacks are bridged to the ivm guest's
 * `__mithic_syscall` handler:
 *   - `pipe/write {fd:1|2}` → relayCtx.writeStdout / writeStderr
 *   - `process/exit`        → relayCtx.notifyExit + close stdio
 *   - `process/getpid`      → returns the pid from ProcessInit
 *   - everything else (fs/*, pipe/read|write|close on relay fds, ipc/*, net/*) →
 *     relayCtx.onSyscall, which the KERNEL routes through its dispatcher with the
 *     correct kernel-owned pid and full in-kernel capability checks. The launcher
 *     never touches the dispatcher or forges a pid — identical security posture
 *     to the transfer path.
 *
 * The handler returns a WRAPPED `{ok,result|error}` so the ivm guest bootstrap's
 * `__mithic_syscall` unwraps it (returning the result or throwing with the errno).
 */
import type { ProcessHandle, Runtime } from '@mithic/runtime';
import type { IvmRuntime } from '@mithic/runtime/backends/ivm';
import type { RelayContext, RelayLauncher } from '../kernel.ts';

export class IvmRelayLauncher implements RelayLauncher {
  #rt: IvmRuntime;

  constructor(rt: IvmRuntime) {
    this.#rt = rt;
  }

  async launchRelay(_runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    const onSyscall = async (call: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (call === 'pipe/write' && (Number(args['fd']) === 1 || Number(args['fd']) === 2)) {
        const chunk = toBytes(args['data']);
        if (Number(args['fd']) === 1) ctx.writeStdout(chunk);
        else ctx.writeStderr(chunk);
        return { ok: true, result: { written: chunk.byteLength } };
      }
      if (call === 'process/exit') {
        ctx.closeStdout();
        ctx.closeStderr();
        ctx.notifyExit(Number(args['code'] ?? 0));
        return { ok: true, result: {} };
      }
      if (call === 'process/getpid') {
        return { ok: true, result: { pid: ctx.init.pid } };
      }
      // KERNEL-routed: the kernel binds the pid and enforces capabilities. Return
      // the wrapped {ok,result|error} the ivm guest bootstrap unwraps.
      const res = await ctx.onSyscall(call, args);
      return res.ok
        ? { ok: true, result: res.result as Record<string, unknown> }
        : { ok: false, error: res.error };
    };

    const handle = await this.#rt.spawn(ctx.code, { init: ctx.init, onSyscall });

    // When the isolate exits naturally (no explicit process/exit), close stdio and
    // notify the kernel of the exit code.
    this.#rt.waitExit(handle).then(({ code }) => {
      ctx.closeStdout();
      ctx.closeStderr();
      ctx.notifyExit(code);
    }).catch(() => ctx.notifyExit(1));

    return handle;
  }
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(0);
}
