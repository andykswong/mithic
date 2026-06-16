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
 *  - inbound `{ __isola_run: string }` — evaluates guest code and calls __isola_main()
 *  - inbound other messages — delivered to __isola_recv() if set
 */
export const BOOTSTRAP_SOURCE = /* js */`
self.__post = (msg) => { postMessage(msg); };
onmessage = (e) => {
  const data = e.data;
  if (data && typeof data === 'object' && '__isola_run' in data && typeof data.__isola_run === 'string') {
    (0, eval)(data.__isola_run);
    const main = globalThis.__isola_main;
    if (typeof main === 'function') {
      try { main(); } catch (err) { postMessage({ __isola_error: String(err) }); }
    }
  } else {
    const recv = globalThis.__isola_recv;
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

let _nextId = 1;

export class WorkerRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = WORKER_CAPABILITIES;

  #processes = new Map<number, WorkerEntry>();
  #factory: WorkerFactory;

  constructor(factory?: WorkerFactory) {
    this.#factory = factory ?? defaultWorkerFactory();
  }

  async spawn(code: string | URL, _options: SpawnOptions): Promise<ProcessHandle> {
    const id = _nextId++;

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

    worker.postMessage({ __isola_run: codeStr });

    return { id };
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    const entry = this.#processes.get(handle.id);
    if (entry) {
      entry.worker.terminate();
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
