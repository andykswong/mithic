import type { SyscallRequest, SyscallResponse, KernelEvent, Signal } from '@mithic/protocol';
import {
  WORKER_CAPABILITIES,
  type Runtime,
  type RuntimeCapabilities,
  type ProcessHandle,
  type SpawnOptions,
} from '../runtime.ts';

/**
 * Bootstrap script injected into every worker.
 * Exposes:
 *  - `self.__post(msg)` — sends a SyscallRequest to the host
 *  - inbound `{ __mithic_init: ProcessInit, ports: Transferable[] }` — stores the boot object for guest delivery
 *  - inbound `{ __mithic_run: string }` — evaluates guest code; calls its default export with boot if available,
 *    otherwise falls back to calling __mithic_main() for backward compatibility
 *  - inbound other messages — delivered to __mithic_recv() if set
 *
 * Boot object delivered to the guest default export:
 *   { control: ports[0], init: ProcessInit, preopenPorts: { 0: ports[1], 1: ports[2], 2: ports[3], ... } }
 * Non-null entries in ports[1..] are keyed by their 0-based index (stdin=0, stdout=1, stderr=2).
 */
export const BOOTSTRAP_SOURCE = /* js */`
self.__post = (msg) => { postMessage(msg); };
let __mithic_boot = null;
onmessage = (e) => {
  const data = e.data;
  if (data && typeof data === 'object' && '__mithic_init' in data) {
    const ports = Array.isArray(data.ports) ? data.ports : [];
    const preopenPorts = {};
    for (let i = 1; i < ports.length; i++) {
      if (ports[i] != null) preopenPorts[i - 1] = ports[i];
    }
    __mithic_boot = { control: ports[0], init: data.__mithic_init, preopenPorts };
  } else if (data && typeof data === 'object' && '__mithic_run' in data && typeof data.__mithic_run === 'string') {
    (0, eval)(data.__mithic_run);
    const defaultExport = globalThis.__mithic_default;
    const main = globalThis.__mithic_main;
    if (typeof defaultExport === 'function') {
      Promise.resolve(defaultExport(__mithic_boot)).catch((err) => postMessage({ __mithic_error: String(err) }));
    } else if (typeof main === 'function') {
      try { main(); } catch (err) { postMessage({ __mithic_error: String(err) }); }
    }
  } else {
    const recv = globalThis.__mithic_recv;
    if (typeof recv === 'function') recv(data);
  }
};
`;

export interface WorkerFactory {
  create(bootstrapSrc: string): WorkerLike;
}

export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer?: Transferable[]): void;
  terminate(): void | Promise<number>;
}

interface WorkerEntry {
  worker: WorkerLike;
  callbacks: ((msg: SyscallRequest) => void)[];
}

function defaultWorkerFactory(): WorkerFactory {
  return {
    create(bootstrapSrc: string): WorkerLike {
      let workerUrl: string;

      // Use Blob URL when available (browser + Node with URL.createObjectURL).
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blob = new Blob([bootstrapSrc], { type: 'text/javascript' });
        workerUrl = URL.createObjectURL(blob);
      } else {
        workerUrl = `data:text/javascript,${encodeURIComponent(bootstrapSrc)}`;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const W = (globalThis as any).Worker as typeof Worker;
      return new W(workerUrl, { type: 'classic' });
    },
  };
}

export class WorkerRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = WORKER_CAPABILITIES;

  #nextId = 1;
  #processes = new Map<number, WorkerEntry>();
  #factory: WorkerFactory;

  constructor(factory?: WorkerFactory) {
    this.#factory = factory ?? defaultWorkerFactory();
  }

  async spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;

    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      codeStr = `await import(${JSON.stringify(code instanceof URL ? code.href : String(code))});`;
    }

    const worker = this.#factory.create(BOOTSTRAP_SOURCE);
    const entry: WorkerEntry = { worker, callbacks: [] };
    this.#processes.set(id, entry);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as SyscallRequest;
      for (const cb of entry.callbacks) {
        cb(msg);
      }
    };

    // Deliver boot object: __mithic_init + transfer list [controlPort, stdinPort, stdoutPort, stderrPort, ...extra]
    if (options.transfer && options.transfer.length > 0) {
      worker.postMessage({ __mithic_init: options.init, ports: options.transfer }, options.transfer);
    }

    worker.postMessage({ __mithic_run: codeStr });

    return { id };
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.worker.terminate();
      this.#processes.delete(handle.id);
    }
  }

  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, transfer?: Transferable[]): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.worker.postMessage(msg, transfer);
    }
  }

  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.callbacks.push(cb);
    }
  }

  isAlive(handle: ProcessHandle): boolean {
    return this.#processes.has(handle.id);
  }

  dispose(handle: ProcessHandle): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.worker.terminate();
      this.#processes.delete(handle.id);
    }
  }
}
