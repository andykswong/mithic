/**
 * @mithic/server — Hono HTTP app exposing sandboxed process execution.
 *
 * ## Backend choice: QuickJS
 *
 * QuickJS (`@mithic/runtime/backends/quickjs`) is the default backend because:
 *   - It enforces `timeoutMs` and `cpuMs` limits via a WASM interrupt handler
 *     (real enforcement, not a best-effort race). This is the only backend that
 *     makes the timeout test deterministic in the Node environment.
 *   - It is fully portable (no SharedArrayBuffer / COOP-COEP headers needed).
 *   - It runs on the same JS thread, so no Worker is required (works in any Node
 *     process without --experimental-worker or special flags).
 *
 * Guest code uses `__isola_syscall` directly (the relay protocol), not
 * `@mithic/guest-runtime`'s MessagePort path. This matches the QuickJS contract.
 *
 * ## Pool
 *
 * TODO (Open Question 4): pool warm QuickJS VMs to amortise the WASM module load
 * cost. Currently each /exec request creates a fresh QuickJSRuntime.create() call.
 * QuickJSRuntime.create() shares the WASM module instance (it's loaded once), so
 * the overhead per request is a new QJS runtime + context, which is cheap — but
 * pooling idle VMs would still improve tail latency for burst traffic.
 */

import { Hono } from 'hono';
import type { ProcessLimits } from '@mithic/protocol';
import { Kernel } from '@mithic/kernel';
import type { RelayContext, RelayLauncher } from '@mithic/kernel';
import type { ProcessHandle, Runtime } from '@mithic/runtime';
import { QuickJSRuntime } from '@mithic/runtime/backends/quickjs';
import type { QuickJSSpawnOptions } from '@mithic/runtime/backends/quickjs';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

// ---------------------------------------------------------------------------
// QuickJS relay launcher (bridges RelayContext ↔ QuickJSRuntime.spawn)
// ---------------------------------------------------------------------------

/**
 * Relay launcher for the QuickJS backend.
 *
 * Bridges the kernel's {@link RelayContext} callbacks to
 * `QuickJSRuntime.spawn()`'s `onSyscall` handler:
 *   - `pipe/write`    → `ctx.writeStdout` / `ctx.writeStderr`
 *   - `process/exit`  → `ctx.closeStdout` + `ctx.closeStderr` + `ctx.notifyExit`
 *   - `process/getpid`→ returns `ctx.init.pid`
 *   - everything else → routed through the KERNEL via `ctx.onSyscall`
 *                        (capability checks always run in-kernel)
 */
class QuickJSRelayLauncher implements RelayLauncher {
  #rt: QuickJSRuntime;

  constructor(rt: QuickJSRuntime) {
    this.#rt = rt;
  }

  async launchRelay(runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    void runtime;

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
          const res = await ctx.onSyscall(call, args);
          if (res.ok) return res.result as Record<string, unknown>;
          throw new Error(`${res.error.code}: ${res.error.message}`);
        }
      }
    };

    const opts: QuickJSSpawnOptions = { init: ctx.init, onSyscall };
    const handle = await this.#rt.spawn(ctx.code, opts);

    // Natural exit (no explicit process/exit): close pipes + notify.
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
// /exec request/response types
// ---------------------------------------------------------------------------

export interface ExecRequest {
  /** Guest source code (QuickJS relay: uses __isola_syscall directly). */
  code: string;
  /** Optional stdin (not yet piped; reserved for future use). */
  stdin?: string;
  /** Environment variables forwarded to the guest. */
  env?: Record<string, string>;
  /** Resource limits for this execution. */
  limits?: ProcessLimits;
}

export interface ExecResponse {
  /** Exit code reported by the guest (or 137 for OOM / SIGKILL). */
  exitCode: number;
  /** Captured stdout decoded as UTF-8. */
  stdout: string;
  /** Captured stderr decoded as UTF-8. */
  stderr: string;
  /** True when the process was killed due to a limit (timeoutMs / memoryMb). */
  limitHit: boolean;
}

// ---------------------------------------------------------------------------
// Hono app factory
// ---------------------------------------------------------------------------

/**
 * Build and return the Hono app.  Exported separately so tests can call
 * `app.request()` without binding to a real TCP socket.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.post('/exec', async (c) => {
    let body: ExecRequest;
    try {
      body = await c.req.json<ExecRequest>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.code !== 'string' || body.code.trim() === '') {
      return c.json({ error: '`code` must be a non-empty string' }, 400);
    }

    const dec = new TextDecoder();

    // Each request gets a fresh QuickJS runtime (no pooling yet; see TODO above).
    const qjsRt = await QuickJSRuntime.create();
    const vfs = new FileSystemRouter();
    await vfs.mount('/', new MemoryFsProvider());

    const kernel = new Kernel({
      runtime: qjsRt,
      vfs,
      relayLauncher: new QuickJSRelayLauncher(qjsRt),
    });

    const { pid, stdout, stderr } = await kernel.spawn(body.code, {
      env: body.env ?? {},
      captureStdout: true,
      captureStderr: true,
      limits: body.limits,
    });

    const result = await kernel.wait(pid);
    const stdoutBytes = stdout ? await stdout : new Uint8Array();
    const stderrBytes = stderr ? await stderr : new Uint8Array();

    // limitHit: true when resource limits were set AND the process exited non-zero.
    // QuickJS timeoutMs/cpuMs enforcement exits with code 1 (interrupt handler throws
    // InternalError: interrupted, which is NOT OOM so it maps to exitCode 1, not 137).
    // OOM / kernel SIGKILL exits with 137. Either way a non-zero exit under limits
    // signals a limit was hit. If the guest itself exits non-zero without limits, this
    // is false (no limits were configured).
    const limitHit = result.code !== 0 && body.limits != null && (
      body.limits.timeoutMs != null ||
      body.limits.cpuMs != null ||
      body.limits.memoryMb != null
    );

    const response: ExecResponse = {
      exitCode: result.code,
      stdout: dec.decode(stdoutBytes),
      stderr: dec.decode(stderrBytes),
      limitHit,
    };

    return c.json(response, 200);
  });

  return app;
}
