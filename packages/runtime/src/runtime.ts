import type { SyscallRequest, SyscallResponse, KernelEvent, Signal } from '@mithic/protocol';
import type { ProcessInit } from '@mithic/protocol';

export interface RuntimeCapabilities {
  gui: boolean;
  transferable: boolean;
  directPipes: boolean;
  deterministic: boolean;
  memoryLimit: boolean;
  cpuLimit: boolean;
  parallelism: boolean;
  interruptible: boolean;
}

export interface ProcessHandle {
  readonly id: number;
}

export interface SpawnOptions {
  init: ProcessInit;
  transfer?: Transferable[];
  /**
   * K2: maps each transferred stdio port (i.e. `transfer[1..]`, after the control
   * port at `transfer[0]`) to the GUEST preopen fd it should appear at. Parallel
   * to `transfer.slice(1)`. When omitted the backend falls back to positional
   * mapping (`transfer[i]` → fd `i-1`), i.e. stdin=0/stdout=1/stderr=2. Supplying
   * it lets the kernel wire arbitrary preopen fds (fd >= 3) without padding the
   * transfer list with non-transferable nulls.
   */
  preopenFds?: number[];
  display?: {
    mode: 'hidden' | 'inline' | 'window' | 'fullscreen';
    width?: number;
    height?: number;
    title?: string;
    /**
     * Per-process mount target for visible modes. When set, the backend appends the
     * guest iframe into THIS element instead of the runtime's shared `container`, so
     * a window manager can create the iframe inside its own window frame and never
     * reparent it (reparenting reloads the iframe and kills the guest). Host-side
     * only (an HTMLElement) — deliberately NOT on the protocol wire.
     */
    container?: HTMLElement;
  };
}

export interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle>;
  /**
   * Terminate the process. The `signal` is ADVISORY: every backend hard-kills
   * regardless of which signal is passed — worker/iframe tear down the worker/iframe,
   * quickjs/ivm dispose the runtime/isolate and report exit code 137. Backends do
   * NOT deliver the signal to the guest for graceful handling; the kernel computes
   * any 128+N exit semantics on its side. The iframe backend additionally has no
   * exit-code channel (DOM removal is the only signal). Callers needing graceful
   * shutdown must coordinate via a kernel-level signal event, not `kill`.
   */
  kill(handle: ProcessHandle, signal: Signal): void;
  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, transfer?: Transferable[]): void;
  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void;
  isAlive(handle: ProcessHandle): boolean;
  dispose(handle: ProcessHandle): void;
  /**
   * Resolve when the process exits, with its exit code. Provided by RELAY backends
   * (quickjs/ivm) where the kernel relay launcher needs the exit code to notify the
   * kernel. Transferable backends (worker/iframe) omit it — they have no exit-code
   * channel; exit is observed via the control port / DOM teardown instead. A caller
   * holding only the `Runtime` interface type MUST feature-detect (`if (rt.waitExit)`)
   * before calling; a launcher typed against the concrete relay backend
   * (`IvmRuntime`/`QuickJSRuntime`, where `waitExit` is non-optional) may call it directly.
   */
  waitExit?(handle: ProcessHandle): Promise<{ code: number }>;
}

export const WORKER_CAPABILITIES: RuntimeCapabilities = {
  gui: false,
  transferable: true,
  directPipes: true,
  deterministic: false,
  memoryLimit: false,
  cpuLimit: false,
  parallelism: true,
  interruptible: true,
};

export const IFRAME_CAPABILITIES: RuntimeCapabilities = {
  gui: true,
  transferable: true,
  directPipes: true,
  deterministic: false,
  memoryLimit: false,
  cpuLimit: false,
  parallelism: true,
  interruptible: false,
};

/**
 * QuickJS (quickjs-emscripten) backend capabilities.
 *
 * - `transferable: false` / `directPipes: false`: no MessagePort transfer — the
 *   kernel uses the relay path and routes syscalls in-kernel via `RelayContext.onSyscall`.
 * - `memoryLimit: true`: enforced via `setMemoryLimit` (hard QuickJS heap cap).
 * - `cpuLimit: true`: enforced via the interrupt handler, which honors BOTH a
 *   wall-clock `timeoutMs` deadline AND a CPU-op budget derived from `cpuMs`
 *   (opcode-count proxy, since QuickJS exposes no true CPU-time counter).
 */
export const QUICKJS_CAPABILITIES: RuntimeCapabilities = {
  gui: false,
  transferable: false,
  directPipes: false,
  deterministic: true,
  memoryLimit: true,
  cpuLimit: true,
  parallelism: false,
  interruptible: true,
};

/**
 * IVM (isolated-vm) backend capabilities.
 *
 * `cpuLimit: true` — H3: `IvmRuntime` polls `isolate.cpuTime` (true CPU-time
 * metering, nanoseconds) against the `cpuMs` budget in a watchdog and disposes the
 * isolate when it is exceeded. This is real CPU metering, not a wall-clock
 * deadline, so the capability is advertised honestly.
 *
 * `memoryLimit: true` — enforced via the `memoryLimit` constructor option
 * (hard V8 heap cap that terminates the isolate on OOM).
 */
export const IVM_CAPABILITIES: RuntimeCapabilities = {
  gui: false,
  transferable: false,
  directPipes: false,
  deterministic: false,
  memoryLimit: true,
  cpuLimit: true,
  parallelism: true,
  interruptible: true,
};
