import type { SyscallRequest, SyscallResponse, KernelEvent, Signal } from '@mithic/protocol';
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten';
import type { QuickJSAsyncWASMModule, QuickJSAsyncContext, QuickJSHandle, JSPromiseState } from 'quickjs-emscripten';
import {
  QUICKJS_CAPABILITIES,
  type Runtime,
  type RuntimeCapabilities,
  type ProcessHandle,
  type SpawnOptions,
} from '../runtime.ts';

/** Extended spawn options for the QuickJS backend. */
export interface QuickJSSpawnOptions extends SpawnOptions {
  /**
   * Called by the asyncify bridge when the guest invokes `__isola_syscall(call, args)`.
   * Returns a plain object that is JSON-cloned back into the guest.
   *
   * The asyncified bridge suspends the WASM call stack while awaiting this handler
   * and resumes it with the serialised result.  From the guest's perspective the
   * call is synchronous: `const r = __isola_syscall(call, args)`.  Using
   * `await __isola_syscall(...)` also works because `await <non-Promise>` in an
   * async context resolves via a QJS microtask, driven by the event-loop pump.
   */
  onSyscall: (call: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Approximate number of guest opcodes between interrupt-handler invocations.
 * quickjs-emscripten invokes the interrupt handler periodically as the guest
 * executes; this is the per-invocation opcode proxy used to derive an opcode
 * budget from a `cpuMs` limit. It is intentionally a coarse proxy — QuickJS does
 * not expose true CPU time.
 */
const INTERRUPT_OP_INTERVAL = 1000;

/**
 * Opcode budget per millisecond of `cpuMs`. A coarse proxy mapping the requested
 * CPU-time budget onto an executed-opcode count, since quickjs-emscripten does
 * not expose CPU time. Tuned so that a small `cpuMs` aborts a tight infinite
 * loop while allowing normal short-lived guests to complete.
 */
const CPU_OPS_PER_MS = 100_000;

/** Exit result returned by `waitExit`. */
export interface ExitResult {
  code: number;
}

/** Per-process state tracked by QuickJSRuntime. */
interface ProcessEntry {
  qjsRuntime: ReturnType<QuickJSAsyncWASMModule['newRuntime']>;
  ctx: QuickJSAsyncContext;
  exitCode: number | undefined;
  exitResolvers: ((result: ExitResult) => void)[];
  alive: boolean;
  /** Set to true when OOM killed the runtime — skip dispose. */
  oomDead: boolean;
}

/**
 * QuickJS backend — runs guest JS in an embedded quickjs-emscripten WASM sandbox.
 *
 * Capabilities: gui=F, transferable=F, directPipes=F, deterministic=T,
 *               memoryLimit=T, cpuLimit=T, parallelism=F, interruptible=T.
 *
 * ## Asyncify syscall bridge
 *
 * `__isola_syscall(call, args)` is injected as an asyncified function via
 * `newAsyncifiedFunction`.  Asyncify instrumentation in the WASM module suspends
 * the entire guest call stack when `__isola_syscall` is invoked, yields control
 * to the JS event loop so the host `onSyscall` handler can `await` its work, then
 * resumes the WASM stack with the serialised response.  From the guest's perspective
 * the call appears synchronous: `const r = __isola_syscall(call, args)`.
 * Using `await __isola_syscall(...)` also works — `await <non-Promise>` schedules
 * a QJS microtask that the host pumps via `executePendingJobs`.
 *
 * The host pumps `runtime.executePendingJobs()` in a `setImmediate` loop after
 * `evalCodeAsync` returns (with a pending-promise handle) so that QJS microtasks
 * (promise continuations) settle on the JS event loop.
 *
 * ## Memory / CPU limits
 *
 * `setMemoryLimit` hard-limits the QuickJS heap.  OOM manifests as a rejected
 * promise inside the async wrapper; the host detects it via `getPromiseState` and
 * assigns exit code 137.  **After OOM `qjsRuntime.dispose()` will abort the WASM
 * module** — we skip it and let the runtime be garbage-collected instead.
 *
 * CPU/wall-clock limits are both enforced by `setInterruptHandler`, which fires
 * roughly every INTERRUPT_OP_INTERVAL opcodes. It (a) compares `Date.now()`
 * against a `timeoutMs`-derived wall-clock deadline and (b) enforces a CPU-op
 * budget derived from `cpuMs` (handler invocations × interval ≈ opcodes executed,
 * aborting once the budget is exceeded). QuickJS exposes no true CPU-time counter,
 * so the opcode count is a conservative proxy — this is what backs
 * `QUICKJS_CAPABILITIES.cpuLimit === true`.
 *
 * ## Data crossing the boundary
 *
 * Values are always copied (JSON round-trip), never transferred.
 * `fs/port` syscalls return ENOSYS — no transferable ports in this backend.
 */
export class QuickJSRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = QUICKJS_CAPABILITIES;

  #module: QuickJSAsyncWASMModule;
  #nextId = 1;
  #processes = new Map<number, ProcessEntry>();
  #resultCallbacks: ((v: unknown) => void)[] = [];

  private constructor(module: QuickJSAsyncWASMModule) {
    this.#module = module;
  }

  /** Load the Asyncify WASM module once and return a ready runtime instance. */
  static async create(): Promise<QuickJSRuntime> {
    const module = await newQuickJSAsyncWASMModule();
    return new QuickJSRuntime(module);
  }

  /**
   * Register a callback invoked whenever guest code calls `__isola_done(value)`.
   * Fires for every subsequent spawn.
   */
  onResult(cb: (v: unknown) => void): void {
    this.#resultCallbacks.push(cb);
  }

  /** Wait for a spawned process to exit and return its exit code. */
  waitExit(handle: ProcessHandle): Promise<ExitResult> {
    const entry = this.#processes.get(handle.id);
    if (!entry) {
      return Promise.resolve({ code: 1 });
    }
    if (entry.exitCode !== undefined) {
      return Promise.resolve({ code: entry.exitCode });
    }
    return new Promise<ExitResult>((resolve) => {
      entry.exitResolvers.push(resolve);
    });
  }

  async spawn(code: string | URL, options: QuickJSSpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;
    const init = options.init;
    const limits = init.limits;

    // Each process gets its own QuickJS runtime + context for isolation.
    const qjsRuntime = this.#module.newRuntime();

    // Apply memory limit (bytes).
    if (limits?.memoryMb != null) {
      qjsRuntime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    }

    // Interrupt handler enforces BOTH a wall-clock deadline (timeoutMs) AND a
    // CPU-op budget derived from cpuMs. The handler fires roughly every
    // INTERRUPT_OP_INTERVAL opcodes, so we count handler invocations and multiply
    // by the interval to get an opcode-count proxy. cpuMs is converted to an
    // opcode budget via CPU_OPS_PER_MS (a conservative proxy: real CPU time is not
    // exposed by quickjs-emscripten, so we bound executed opcodes instead). This
    // honors QUICKJS_CAPABILITIES.cpuLimit === true.
    const timeoutMs = limits?.timeoutMs ?? 0;
    const cpuMs = limits?.cpuMs ?? 0;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const opBudget = cpuMs > 0 ? cpuMs * CPU_OPS_PER_MS : 0;
    if (deadline > 0 || opBudget > 0) {
      let invocations = 0;
      qjsRuntime.setInterruptHandler(() => {
        invocations++;
        // Opcode-count-derived CPU budget: invocations * interval ≈ ops executed.
        if (opBudget > 0 && invocations * INTERRUPT_OP_INTERVAL >= opBudget) return true;
        // Wall-clock deadline, sampled periodically to keep the check cheap.
        if (deadline > 0 && invocations % 1000 === 0 && Date.now() > deadline) return true;
        return false;
      });
    }

    const ctx = qjsRuntime.newContext() as QuickJSAsyncContext;

    const entry: ProcessEntry = {
      qjsRuntime,
      ctx,
      exitCode: undefined,
      exitResolvers: [],
      alive: true,
      oomDead: false,
    };
    this.#processes.set(id, entry);

    const resultCallbacks = this.#resultCallbacks;

    // __isola_syscall: asyncified bridge — WASM stack suspends; JS awaits; stack resumes.
    const syscallFn = ctx.newAsyncifiedFunction(
      '__isola_syscall',
      async (callHandle: QuickJSHandle, argsHandle: QuickJSHandle): Promise<QuickJSHandle> => {
        const call = ctx.getString(callHandle);
        const argsRaw = ctx.dump(argsHandle);
        const args = typeof argsRaw === 'object' && argsRaw !== null
          ? (argsRaw as Record<string, unknown>)
          : {};
        // QUICKJS_CAPABILITIES.transferable === false: there are no transferable
        // MessagePorts in this backend, so port-based syscalls are unsupported.
        // Reject them here in the backend rather than relying on the launcher.
        if (call === 'fs/port') {
          return jsonToHandle(ctx, {
            ok: false,
            error: { code: 'ENOSYS', message: 'fs/port unsupported: QuickJS backend has no transferable ports' },
          });
        }
        const response = await options.onSyscall(call, args);
        return jsonToHandle(ctx, response);
      }
    );
    ctx.setProp(ctx.global, '__isola_syscall', syscallFn);
    syscallFn.dispose();

    // __isola_done(value): logical completion; fires all onResult callbacks.
    const doneFn = ctx.newFunction('__isola_done', (valueHandle: QuickJSHandle) => {
      const value = ctx.dump(valueHandle);
      for (const cb of resultCallbacks) cb(value);
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, '__isola_done', doneFn);
    doneFn.dispose();

    // __isola_post(msg): general outbound hook — no transferable ports, no-op.
    const postFn = ctx.newFunction('__isola_post', (_: QuickJSHandle) => ctx.undefined);
    ctx.setProp(ctx.global, '__isola_post', postFn);
    postFn.dispose();

    // __isola_init: expose ProcessInit for guests that inspect boot metadata.
    const initHandle = jsonToHandle(ctx, init as unknown as Record<string, unknown>);
    ctx.setProp(ctx.global, '__isola_init', initHandle);
    initHandle.dispose();

    // Resolve code string.
    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      codeStr = `await import(${JSON.stringify(code instanceof URL ? code.href : String(code))});`;
    }

    // Wrap in async IIFE to support top-level `await` in guest code.
    const wrappedCode = `(async function __isola_run() {\n${codeStr}\n})()`;

    // Drive the QJS event loop: pump microtasks until the queue is empty.
    const driveLoop = (): void => {
      if (!qjsRuntime.alive) return;
      try {
        qjsRuntime.executePendingJobs(100);
      } catch {
        this.#markExit(id, 1);
        this.#disposeEntry(id);
        return;
      }
      if (qjsRuntime.alive && qjsRuntime.hasPendingJob()) {
        setImmediate(driveLoop);
      }
    };

    // evalCodeAsync uses Asyncify to suspend WASM on async calls inside the guest.
    const evalPromise = ctx.evalCodeAsync(wrappedCode);

    evalPromise.then((result) => {
      if (!qjsRuntime.alive) return;

      if (result.error) {
        // Immediate error (syntax error, or non-async OOM).
        let exitCode = 1;
        try {
          if (ctx.alive) {
            const errDump = ctx.dump(result.error);
            if (
              typeof errDump === 'object' && errDump !== null
              && (errDump as { message?: unknown }).message === 'out of memory'
            ) exitCode = 137;
          }
        } catch { /* ignore */ }
        try { result.error.dispose(); } catch { /* ignore */ }
        this.#markExit(id, exitCode);
        this.#disposeEntry(id);
        return;
      }

      // Async wrapper returns a promise handle — inspect its state.
      let promiseState: JSPromiseState | null = null;
      try {
        if (ctx.alive) promiseState = ctx.getPromiseState(result.value);
      } catch { /* ignore */ }

      if (promiseState?.type === 'rejected') {
        // OOM (or other async rejection) propagated through the async wrapper.
        let exitCode = 1;
        try {
          if ('error' in promiseState && promiseState.error && ctx.alive) {
            const errDump = ctx.dump(promiseState.error);
            if (
              typeof errDump === 'object' && errDump !== null
              && (errDump as { message?: unknown }).message === 'out of memory'
            ) exitCode = 137;
          }
        } catch { /* ignore */ }
        if (exitCode === 137) entry.oomDead = true;
        try { result.value.dispose(); } catch { /* ignore */ }
        this.#markExit(id, exitCode);
        this.#disposeEntry(id);
        return;
      }

      // Fulfilled or still pending — drive the QJS event loop for pending microtasks.
      try { result.value.dispose(); } catch { /* ignore */ }
      driveLoop();

      // After pumping, mark exit 0 on the next tick (lets __isola_done fire first).
      setImmediate(() => {
        driveLoop();
        setImmediate(() => {
          if (entry.alive) {
            this.#markExit(id, 0);
            this.#disposeEntry(id);
          }
        });
      });
    }).catch(() => {
      if (!entry.alive) return;
      this.#markExit(id, 1);
      this.#disposeEntry(id);
    });

    // Kick off the event loop immediately.
    setImmediate(driveLoop);

    return { id };
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    this.#markExit(handle.id, 137);
    this.#disposeEntry(handle.id);
  }

  postMessage(_handle: ProcessHandle, _msg: SyscallResponse | KernelEvent, _transfer?: Transferable[]): void {
    // No transferable ports; no-op.
  }

  onMessage(_handle: ProcessHandle, _cb: (msg: SyscallRequest) => void): void {
    // Messages routed via onSyscall; no generic listener.
  }

  isAlive(handle: ProcessHandle): boolean {
    return this.#processes.get(handle.id)?.alive === true;
  }

  dispose(handle: ProcessHandle): void {
    this.#markExit(handle.id, 0);
    this.#disposeEntry(handle.id);
  }

  #markExit(id: number, code: number): void {
    const entry = this.#processes.get(id);
    if (!entry || entry.exitCode !== undefined) return;
    entry.exitCode = code;
    entry.alive = false;
    for (const resolve of entry.exitResolvers) resolve({ code });
    entry.exitResolvers.length = 0;
  }

  #disposeEntry(id: number): void {
    const entry = this.#processes.get(id);
    if (!entry) return;
    this.#processes.delete(id);
    try {
      if (entry.ctx.alive) entry.ctx.dispose();
    } catch { /* already disposed */ }
    // After OOM the runtime is in a corrupted state — disposing it aborts the WASM
    // module.  Leave it for GC instead of calling dispose().
    if (!entry.oomDead) {
      try {
        if (entry.qjsRuntime.alive) entry.qjsRuntime.dispose();
      } catch { /* already disposed */ }
    }
  }
}

/**
 * Deep-copy a JSON-compatible JS value into a QuickJSHandle.
 * The caller owns the returned handle and must dispose it.
 */
function jsonToHandle(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return ctx.null;
  if (typeof value === 'boolean') return value ? ctx.true : ctx.false;
  if (typeof value === 'number') return ctx.newNumber(value);
  if (typeof value === 'string') return ctx.newString(value);
  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    for (let i = 0; i < value.length; i++) {
      const item = jsonToHandle(ctx, (value as unknown[])[i]);
      ctx.setProp(arr, i, item);
      item.dispose();
    }
    return arr;
  }
  if (typeof value === 'object') {
    const obj = ctx.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const val = jsonToHandle(ctx, v);
      ctx.setProp(obj, k, val);
      val.dispose();
    }
    return obj;
  }
  return ctx.newString(String(value));
}
