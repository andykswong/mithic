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
  display?: {
    mode: 'hidden' | 'inline' | 'window' | 'fullscreen';
    width?: number;
    height?: number;
    title?: string;
  };
}

export interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle>;
  kill(handle: ProcessHandle, signal: Signal): void;
  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, transfer?: Transferable[]): void;
  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void;
  isAlive(handle: ProcessHandle): boolean;
  dispose(handle: ProcessHandle): void;
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
