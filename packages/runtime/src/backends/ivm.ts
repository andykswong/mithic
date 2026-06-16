// IVM (isolated-vm) backend for @mithic/runtime.
// This backend uses the `isolated-vm` native Node.js addon for true V8 isolate
// sandboxing with memory and CPU limits.
//
// Node 20+ requires --no-node-snapshot when using isolated-vm due to:
// https://github.com/laverdet/isolated-vm#requirements
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

/** Returns true if isolated-vm is loadable in this environment, false otherwise. Never throws. */
export async function isIvmAvailable(): Promise<boolean> {
  try {
    // Use an indirect dynamic import via new Function so TypeScript does not
    // perform static module-resolution on 'isolated-vm'. The optional native
    // addon may not be installed, and a hard TS2307 error would break builds.
    await (new Function('m', 'return import(m)') as (m: string) => Promise<unknown>)('isolated-vm');
    return true;
  } catch {
    return false;
  }
}

interface IvmEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isolate: any;
  callbacks: ((msg: SyscallRequest) => void)[];
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
    // Indirect dynamic import — same reason as in isIvmAvailable: avoids TS2307.
    const ivm: IvmModule = await (new Function('m', 'return import(m)') as (m: string) => Promise<IvmModule>)('isolated-vm');
    return new IvmRuntime(ivm, memoryLimitMb);
  }

  async spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;

    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      codeStr = String(code instanceof URL ? code.href : code);
    }

    // Create a new V8 isolate with the configured memory limit.
    const isolate = new this.#ivm.Isolate({ memoryLimit: this.#memoryLimitMb });
    const entry: IvmEntry = { isolate, callbacks: [] };
    this.#processes.set(id, entry);

    const context = await isolate.createContext();

    // Inject __isola_syscall as an async Callback so guest code can post
    // SyscallRequests back to the host. The callback is exposed on the global
    // as `__isola_syscall(jsonMsg)`.
    await context.global.set(
      '__isola_syscall',
      new this.#ivm.Callback(
        (jsonMsg: string) => {
          try {
            const msg = JSON.parse(jsonMsg) as SyscallRequest;
            for (const cb of entry.callbacks) {
              cb(msg);
            }
          } catch {
            // Malformed message — ignore.
          }
        },
        { async: true },
      ),
    );

    // Evaluate the guest code. Falls back to 30 s if no limits.timeoutMs supplied.
    // Callers using cpuLimit semantics may also rely on isolate wallTime/cpuTime.
    const timeout = options.init.limits?.timeoutMs ?? 30_000;
    await context.eval(codeStr, { timeout });

    return { id };
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.isolate.dispose();
      this.#processes.delete(handle.id);
    }
  }

  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, _transfer?: Transferable[]): void {
    // isolated-vm does not support Transferable ports; postMessage is a no-op for
    // directPipes=false. Callers that need bidirectional IPC should use syscall responses
    // encoded as JSON passed through __isola_syscall callbacks.
    void handle;
    void msg;
  }

  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.callbacks.push(cb);
    }
  }

  isAlive(handle: ProcessHandle): boolean {
    const entry = this.#processes.get(handle.id);
    if (!entry) return false;
    try {
      // Accessing .isDisposed is synchronous and does not throw.
      return !entry.isolate.isDisposed;
    } catch {
      return false;
    }
  }

  dispose(handle: ProcessHandle): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      if (!entry.isolate.isDisposed) {
        entry.isolate.dispose();
      }
      this.#processes.delete(handle.id);
    }
  }
}
