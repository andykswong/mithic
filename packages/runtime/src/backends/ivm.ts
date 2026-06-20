// IVM (isolated-vm) backend for @mithic/runtime.
// This backend uses the `isolated-vm` native Node.js addon for true V8 isolate
// sandboxing with memory and CPU limits.
//
// isolated-vm v7+ is required for Node 26+ support. Earlier versions (v5) only
// supported up to Node 22. The `--no-node-snapshot` flag was required in older
// versions of isolated-vm but has been fixed in the v7 series.
// See: https://github.com/laverdet/isolated-vm
//
// isolated-vm is declared as an optionalDependency. If the native addon is not
// available (e.g., toolchain absent, unsupported platform), `isIvmAvailable()`
// returns false and IvmRuntime.create() throws. No top-level import of
// isolated-vm is performed, so the package typechecks and builds even when the
// addon is absent.

import type { SyscallRequest, SyscallResponse, KernelEvent, Signal } from '@mithic/protocol';
import {
  IVM_CAPABILITIES,
  type Runtime,
  type RuntimeCapabilities,
  type ProcessHandle,
  type SpawnOptions,
} from '../runtime.ts';

// Loose-typed reference to the ivm module — avoids hard compile-time dependency
// on isolated-vm type declarations (which may not be installed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IvmModule = any;

/**
 * Dynamically load the optional `isolated-vm` native addon WITHOUT a static module
 * specifier (so TS never tries to resolve it — the addon is an optionalDependency
 * that may be absent, and a literal `import('isolated-vm')` would be a TS2307).
 *
 * Two strategies, because environments differ:
 *   1. `new Function('m','return import(m)')` — works under plain Node, keeps the
 *      specifier opaque to the bundler.
 *   2. plain `import(spec)` with a VARIABLE specifier — used when (1) throws "A
 *      dynamic import callback was not specified" (the Vite/vitest module system
 *      does not support the `new Function` import trick). A variable specifier is
 *      still opaque to TS so it does not trigger a static-resolution error.
 */
async function loadIvm(): Promise<IvmModule> {
  try {
    return await (new Function('m', 'return import(m)') as (m: string) => Promise<IvmModule>)('isolated-vm');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/dynamic import callback was not specified/i.test(msg)) {
      const spec = 'isolated-vm';
      return await import(/* @vite-ignore */ spec);
    }
    throw err;
  }
}

/** Returns true if isolated-vm is loadable in this environment, false otherwise. Never throws. */
export async function isIvmAvailable(): Promise<boolean> {
  try {
    await loadIvm();
    return true;
  } catch {
    return false;
  }
}

/**
 * Host syscall handler injected into the isolate. The guest calls
 * `__mithic_syscall(call, args)` synchronously (from its view); the host returns a
 * plain object that is JSON-cloned back into the isolate. The bridge SUSPENDS the
 * isolate thread (via `Reference.applySyncPromise`) while the host `await`s its
 * work, then resumes the isolate with the serialised result — design §4.4.
 */
export interface IvmSpawnOptions extends SpawnOptions {
  onSyscall?: (call: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface IvmEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isolate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
  messageListeners: ((msg: SyscallRequest) => void)[];
  exitCode: number | undefined;
  exitResolvers: ((code: number) => void)[];
  alive: boolean;
  /** cpuLimit watchdog timer (cleared on exit/dispose). */
  cpuWatch: ReturnType<typeof setInterval> | undefined;
}

/** Exit result returned by `waitExit`. */
export interface IvmExitResult {
  code: number;
}

export class IvmRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = IVM_CAPABILITIES;

  #nextId = 1;
  #processes = new Map<number, IvmEntry>();
  #ivm: IvmModule;
  #memoryLimitMb: number;

  private constructor(ivm: IvmModule, memoryLimitMb: number) {
    this.#ivm = ivm;
    this.#memoryLimitMb = memoryLimitMb;
  }

  /**
   * Creates an IvmRuntime. Throws if isolated-vm is not available.
   * @param memoryLimitMb - Per-isolate memory limit in MiB (default 128).
   */
  static async create(memoryLimitMb = 128): Promise<IvmRuntime> {
    const ivm: IvmModule = await loadIvm();
    return new IvmRuntime((ivm.default ?? ivm), memoryLimitMb);
  }

  /**
   * Spawn a guest in a fresh isolate. The guest runs NON-BLOCKING: `spawn`
   * resolves once the isolate is started, so syscalls can be serviced while the
   * guest executes. The guest's `__mithic_syscall(call, args)` is bridged to
   * `options.onSyscall` (when provided) via a host `Reference.applySyncPromise`
   * round-trip, returning the result synchronously into the isolate.
   *
   * Memory is hard-capped via the `memoryLimit` constructor option. cpuMs is
   * enforced via an `isolate.cpuTime` watchdog (true CPU metering, not wall-clock).
   */
  async spawn(code: string | URL, options: IvmSpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;

    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      // isolated-vm's eval() runs in a fully isolated V8 context that does not
      // have access to the host's module loader, so dynamic import() of a URL is
      // not supported. Throw a clear error rather than silently evaluating the
      // URL string as a no-op JS expression.
      throw new Error('IvmRuntime: URL entry not yet supported');
    }

    const memoryLimit = options.init.limits?.memoryMb ?? this.#memoryLimitMb;
    const isolate = new this.#ivm.Isolate({ memoryLimit });
    const context = await isolate.createContext();
    const entry: IvmEntry = {
      isolate,
      context,
      messageListeners: [],
      exitCode: undefined,
      exitResolvers: [],
      alive: true,
      cpuWatch: undefined,
    };
    this.#processes.set(id, entry);

    // Host syscall handler: returns a JSON-encoded SyscallResponse string. The
    // guest calls it via applySyncPromise (suspends the isolate until resolved).
    const onSyscall = options.onSyscall;
    const syscallRef = new this.#ivm.Reference(async (jsonReq: string): Promise<string> => {
      let req: { call?: string; args?: Record<string, unknown> };
      try { req = JSON.parse(jsonReq); } catch { return JSON.stringify({ ok: false, error: { code: 'EINVAL', message: 'bad syscall request' } }); }
      const call = typeof req.call === 'string' ? req.call : '';
      const args = (req.args && typeof req.args === 'object') ? req.args : {};
      // Also surface the raw request to any onMessage listeners (parity with the
      // pre-existing fire-and-forget behavior that tests relied on).
      for (const cb of entry.messageListeners) {
        cb({ id: 0, call, args } as SyscallRequest);
      }
      if (!onSyscall) {
        return JSON.stringify({ ok: false, error: { code: 'ENOSYS', message: 'no syscall handler' } });
      }
      try {
        const result = await onSyscall(call, args);
        return JSON.stringify(result ?? {});
      } catch (err) {
        const code = (err && typeof err === 'object' && 'code' in err) ? String((err as { code: unknown }).code) : 'EIO';
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ ok: false, error: { code, message } });
      }
    });
    await context.global.set('__mithic_syscall_ref', syscallRef);
    await context.global.set('__mithic_init_json', JSON.stringify(options.init));

    // Bootstrap: a synchronous-looking __mithic_syscall over the suspendable
    // bridge. The handler may return either a bare result object OR a wrapped
    // {ok,result|error}; we normalize so the guest gets the result (or throws).
    await context.eval(`
      globalThis.__mithic_init = JSON.parse(__mithic_init_json);
      globalThis.__mithic_syscall = (call, args) => {
        const json = __mithic_syscall_ref.applySyncPromise(undefined, [JSON.stringify({ call, args: args || {} })]);
        const r = JSON.parse(json);
        if (r && typeof r === 'object' && 'ok' in r) {
          if (r.ok) return r.result;
          const e = new Error((r.error && r.error.message) || 'syscall failed');
          e.code = r.error && r.error.code;
          throw e;
        }
        return r;
      };
    `);

    // cpuMs enforcement: poll isolate.cpuTime (nanoseconds) and dispose when the
    // CPU budget is exceeded. This is real CPU metering (not wall-clock) — backs
    // IVM_CAPABILITIES.cpuLimit === true.
    const cpuMs = options.init.limits?.cpuMs;
    if (cpuMs !== undefined && cpuMs > 0) {
      const budgetNs = BigInt(Math.floor(cpuMs)) * 1_000_000n;
      entry.cpuWatch = setInterval(() => {
        if (!entry.alive) { this.#stopCpuWatch(entry); return; }
        try {
          if ((isolate.cpuTime as bigint) > budgetNs) {
            this.#markExit(id, 137);
            this.#disposeEntry(id);
          }
        } catch { /* isolate gone */ }
      }, 10);
      (entry.cpuWatch as { unref?: () => void }).unref?.();
    }

    // Run the guest NON-BLOCKING: wrap in an async IIFE (for top-level await) and
    // do not await completion here. On settle, mark exit (0 normally, 137 on a
    // RangeError-style OOM/timeout). A guest that calls process/exit settles via
    // its own syscall + the relay launcher's notifyExit.
    const wrapped = `(async () => {\n${codeStr}\n})()`;
    const evalPromise: Promise<unknown> = context.eval(wrapped, { promise: true, timeout: options.init.limits?.timeoutMs });
    evalPromise.then(() => {
      if (entry.alive) { this.#markExit(id, 0); this.#disposeEntry(id); }
    }).catch((err: unknown) => {
      if (!entry.alive) return;
      // A disposed isolate (cpuLimit/OOM kill) rejects here — already handled.
      const msg = err instanceof Error ? err.message : String(err);
      const code = /memory limit|out of memory|disposed|cpu/i.test(msg) ? 137 : 1;
      this.#markExit(id, code);
      this.#disposeEntry(id);
    });

    return { id };
  }

  /** Wait for a spawned process to exit and return its exit code. */
  waitExit(handle: ProcessHandle): Promise<IvmExitResult> {
    const entry = this.#processes.get(handle.id);
    if (!entry) return Promise.resolve({ code: 1 });
    if (entry.exitCode !== undefined) return Promise.resolve({ code: entry.exitCode });
    return new Promise<IvmExitResult>((resolve) => {
      entry.exitResolvers.push((code) => resolve({ code }));
    });
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    this.#markExit(handle.id, 137);
    this.#disposeEntry(handle.id);
  }

  postMessage(_handle: ProcessHandle, _msg: SyscallResponse | KernelEvent, _transfer?: Transferable[]): void {
    // isolated-vm does not support Transferable ports; postMessage is a no-op for
    // directPipes=false. Bidirectional IPC is via syscall responses through the
    // suspendable __mithic_syscall bridge.
  }

  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void {
    const entry = this.#processes.get(handle.id);
    if (entry) entry.messageListeners.push(cb);
  }

  isAlive(handle: ProcessHandle): boolean {
    const entry = this.#processes.get(handle.id);
    if (!entry) return false;
    return entry.alive;
  }

  dispose(handle: ProcessHandle): void {
    this.#markExit(handle.id, this.#processes.get(handle.id)?.exitCode ?? 0);
    this.#disposeEntry(handle.id);
  }

  #markExit(id: number, code: number): void {
    const entry = this.#processes.get(id);
    if (!entry || entry.exitCode !== undefined) return;
    entry.exitCode = code;
    entry.alive = false;
    for (const resolve of entry.exitResolvers) resolve(code);
    entry.exitResolvers.length = 0;
  }

  #stopCpuWatch(entry: IvmEntry): void {
    if (entry.cpuWatch !== undefined) { clearInterval(entry.cpuWatch); entry.cpuWatch = undefined; }
  }

  #disposeEntry(id: number): void {
    const entry = this.#processes.get(id);
    if (!entry) return;
    this.#processes.delete(id);
    this.#stopCpuWatch(entry);
    try { if (!entry.isolate.isDisposed) { entry.context.release(); entry.isolate.dispose(); } } catch { /* already disposed */ }
  }
}

