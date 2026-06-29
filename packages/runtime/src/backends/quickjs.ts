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
   * Called by the asyncify bridge when the guest invokes `__mithic_syscall(call, args)`.
   * Returns a plain object that is JSON-cloned back into the guest.
   *
   * The asyncified bridge suspends the WASM call stack while awaiting this handler
   * and resumes it with the serialised result.  From the guest's perspective the
   * call is synchronous: `const r = __mithic_syscall(call, args)`.  Using
   * `await __mithic_syscall(...)` also works because `await <non-Promise>` in an
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
  /**
   * Set to true when the interrupt handler (timeout / cpu budget) killed the
   * runtime.  Disposing an interrupted runtime triggers a C-level assertion
   * ("Assertion failed: list_empty(&rt->gc_obj_list)"), so we skip dispose and
   * leave the runtime to GC — same accepted tradeoff as the OOM path.
   */
  interruptDead: boolean;
  /**
   * R1: incremented when the guest ENTERS the asyncified `__mithic_syscall`
   * bridge (the WASM call stack suspends awaiting the host) and decremented when
   * the host response resumes the stack. While > 0 the guest is Asyncify-SUSPENDED
   * mid-syscall, and disposing the runtime in that state hits the same C-level
   * assertion ("Assertion failed: list_empty(&rt->gc_obj_list)" in JS_FreeRuntime)
   * as the OOM/interrupt paths. An EXTERNAL `kill()`/`dispose()` while this is > 0
   * (e.g. the kernel's output-cap SIGKILL) therefore SKIPS `qjsRuntime.dispose()`
   * and leaves the runtime to GC — same accepted tradeoff. A counter (not a bool)
   * tolerates re-entrant/overlapping syscalls.
   */
  suspendedInSyscall: number;
}

/**
 * QuickJS backend — runs guest JS in an embedded quickjs-emscripten WASM sandbox.
 *
 * Capabilities: gui=F, transferable=F, directPipes=F, deterministic=T,
 *               memoryLimit=T, cpuLimit=T, parallelism=F, interruptible=T.
 *
 * ## Asyncify syscall bridge
 *
 * `__mithic_syscall(call, args)` is injected as an asyncified function via
 * `newAsyncifiedFunction`.  Asyncify instrumentation in the WASM module suspends
 * the entire guest call stack when `__mithic_syscall` is invoked, yields control
 * to the JS event loop so the host `onSyscall` handler can `await` its work, then
 * resumes the WASM stack with the serialised response.  From the guest's perspective
 * the call appears synchronous: `const r = __mithic_syscall(call, args)`.
 * Using `await __mithic_syscall(...)` also works — `await <non-Promise>` schedules
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
   * Register a callback invoked whenever guest code calls `__mithic_done(value)`.
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

    const ctx = qjsRuntime.newContext() as QuickJSAsyncContext;

    const entry: ProcessEntry = {
      qjsRuntime,
      ctx,
      exitCode: undefined,
      exitResolvers: [],
      alive: true,
      oomDead: false,
      interruptDead: false,
      suspendedInSyscall: 0,
    };

    // Interrupt handler enforces BOTH a wall-clock deadline (timeoutMs) AND a
    // CPU-op budget derived from cpuMs. The handler fires roughly every
    // INTERRUPT_OP_INTERVAL opcodes, so we count handler invocations and multiply
    // by the interval to get an opcode-count proxy. cpuMs is converted to an
    // opcode budget via CPU_OPS_PER_MS (a conservative proxy: real CPU time is not
    // exposed by quickjs-emscripten, so we bound executed opcodes instead). This
    // honors QUICKJS_CAPABILITIES.cpuLimit === true.
    //
    // The handler also sets `entry.interruptDead = true` so `#disposeEntry` can
    // skip `qjsRuntime.dispose()` — disposing an interrupt-killed runtime triggers
    // a C-level assertion ("Assertion failed: list_empty(&rt->gc_obj_list)").
    // Same accepted tradeoff as the OOM path: leave the runtime to GC.
    const timeoutMs = limits?.timeoutMs ?? 0;
    const cpuMs = limits?.cpuMs ?? 0;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const opBudget = cpuMs > 0 ? cpuMs * CPU_OPS_PER_MS : 0;
    if (deadline > 0 || opBudget > 0) {
      let invocations = 0;
      qjsRuntime.setInterruptHandler(() => {
        invocations++;
        // Opcode-count-derived CPU budget: invocations * interval ≈ ops executed.
        if (opBudget > 0 && invocations * INTERRUPT_OP_INTERVAL >= opBudget) {
          entry.interruptDead = true;
          return true;
        }
        // Wall-clock deadline, sampled periodically to keep the check cheap.
        if (deadline > 0 && invocations % 1000 === 0 && Date.now() > deadline) {
          entry.interruptDead = true;
          return true;
        }
        return false;
      });
    }
    this.#processes.set(id, entry);

    const resultCallbacks = this.#resultCallbacks;

    // __mithic_syscall: asyncified bridge — WASM stack suspends; JS awaits; stack resumes.
    const syscallFn = ctx.newAsyncifiedFunction(
      '__mithic_syscall',
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
        // R1: the WASM call stack is Asyncify-SUSPENDED for the duration of this
        // await (awaiting the host). Mark the entry suspended so an external
        // kill()/dispose() that lands while we are parked here SKIPS
        // qjsRuntime.dispose() — disposing a suspended runtime aborts at the C
        // level (list_empty(&rt->gc_obj_list) in JS_FreeRuntime), same as the
        // OOM/interrupt paths. Cleared in finally so a normal resume re-enables
        // the common-case clean dispose.
        entry.suspendedInSyscall++;
        try {
          const response = await options.onSyscall(call, args);
          return jsonToHandle(ctx, response);
        } finally {
          entry.suspendedInSyscall--;
        }
      }
    );
    ctx.setProp(ctx.global, '__mithic_syscall', syscallFn);
    syscallFn.dispose();

    // __mithic_done(value): logical completion; fires all onResult callbacks.
    const doneFn = ctx.newFunction('__mithic_done', (valueHandle: QuickJSHandle) => {
      const value = ctx.dump(valueHandle);
      for (const cb of resultCallbacks) cb(value);
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, '__mithic_done', doneFn);
    doneFn.dispose();

    // __mithic_post(msg): general outbound hook — no transferable ports, no-op.
    const postFn = ctx.newFunction('__mithic_post', (_: QuickJSHandle) => ctx.undefined);
    ctx.setProp(ctx.global, '__mithic_post', postFn);
    postFn.dispose();

    // __mithic_init: expose ProcessInit for guests that inspect boot metadata.
    const initHandle = jsonToHandle(ctx, init as unknown as Record<string, unknown>);
    ctx.setProp(ctx.global, '__mithic_init', initHandle);
    initHandle.dispose();

    // Resolve code string.
    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      // The QuickJS context configures no module loader (`setModuleLoader`), so a
      // dynamic `import(url)` would fail at guest runtime as an opaque exit-1.
      // Reject early with a clear error — same posture as IvmRuntime (which also
      // has no host module loader in its sandbox). Inline source is the supported
      // entry form for this backend.
      throw new Error('QuickJSRuntime: URL entry not supported (no module loader); pass inline source');
    }

    // Wrap in async IIFE to support top-level `await` in guest code.
    const wrappedCode = `(async function __mithic_run() {\n${codeStr}\n})()`;

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
        // OOM (or other async rejection — e.g. an uncaught guest throw) propagated
        // through the async wrapper.
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
        // R1: the rejection ERROR handle is caller-owned and MUST be disposed.
        // Leaving it un-disposed leaves a live object on the runtime's gc_obj_list,
        // so the later qjsRuntime.dispose() aborts at the C level
        // ("Assertion failed: list_empty(&rt->gc_obj_list)" in JS_FreeRuntime) —
        // the exact native abort an uncaught guest throw produced. Disposing it
        // here lets the common error case dispose cleanly (no leaked runtime).
        try { if ('error' in promiseState && promiseState.error) promiseState.error.dispose(); } catch { /* ignore */ }
        if (exitCode === 137) entry.oomDead = true;
        try { result.value.dispose(); } catch { /* ignore */ }
        this.#markExit(id, exitCode);
        this.#disposeEntry(id);
        return;
      }

      // Fulfilled or still pending — drive the QJS event loop for pending microtasks.
      try { result.value.dispose(); } catch { /* ignore */ }
      driveLoop();

      // After pumping, mark exit 0 on the next tick (lets __mithic_done fire first).
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
    // After OOM, interrupt-kill, OR while the guest is Asyncify-SUSPENDED mid-
    // syscall, the runtime cannot be disposed without hitting a C-level assertion
    // ("Assertion failed: list_empty(&rt->gc_obj_list)" in JS_FreeRuntime). The
    // suspended case is the external-kill scenario (R1): an output-cap SIGKILL (or
    // any kill/dispose) lands while the guest is parked in `__mithic_syscall`
    // awaiting a host response that may never come. In all three cases we SKIP
    // dispose() and leave the runtime to GC — accepted tradeoff to avoid the native
    // abort. A non-suspended runtime still disposes cleanly (no leak in the common
    // case).
    if (!entry.oomDead && !entry.interruptDead && entry.suspendedInSyscall === 0) {
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
