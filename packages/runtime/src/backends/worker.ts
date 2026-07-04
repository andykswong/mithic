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
 *  - inbound `{ __mithic_run: { guest, isUrl, imports } }` — OF1/G2 stage 2: mints an
 *    in-sandbox blob: module for the guest (and one per dep in `imports`), builds the frozen
 *    `boot.imports` (specifier → blob URL), `import()`s the guest, and calls its default export
 *    (`mod.default`, or `globalThis.__mithic_default` for an IIFE guest) with boot
 *  - inbound other messages — delivered to __mithic_recv() if set
 *
 * Boot object delivered to the guest default export:
 *   { control: ports[0], init: ProcessInit, preopenPorts: { 0: ports[1], 1: ports[2], 2: ports[3], ... }, imports }
 * Non-null entries in ports[1..] are keyed by their 0-based index (stdin=0, stdout=1, stderr=2).
 * `imports` is a frozen `specifier → blob: URL` map ({} for a zero-dep guest).
 */
export const BOOTSTRAP_SOURCE = /* js */`
self.__post = (msg) => { postMessage(msg); };
let __mithic_boot = null;
onmessage = (e) => {
  const data = e.data;
  if (data && typeof data === 'object' && '__mithic_init' in data) {
    const ports = Array.isArray(data.ports) ? data.ports : [];
    // K2: data.preopenFds (when present) maps ports[1..] to arbitrary guest fds;
    // otherwise fall back to positional mapping (ports[i] -> fd i-1).
    const preopenFds = Array.isArray(data.preopenFds) ? data.preopenFds : null;
    const preopenPorts = {};
    for (let i = 1; i < ports.length; i++) {
      if (ports[i] == null) continue;
      const fd = preopenFds ? preopenFds[i - 1] : i - 1;
      if (typeof fd === 'number') preopenPorts[fd] = ports[i];
    }
    __mithic_boot = { control: ports[0], init: data.__mithic_init, preopenPorts, imports: {} };
  } else if (data && typeof data === 'object' && '__mithic_run' in data && data.__mithic_run && typeof data.__mithic_run === 'object') {
    // OF1/G2 stage 2 (spec §4.2): mint in-sandbox blob: modules for guest + deps, build boot.imports, import() the guest. The old (0,eval) path is removed; this is the sole guest-load path. Dep blob URLs live for the (one-guest) worker lifetime (reclaimed at teardown); the guest URL is revoked after its import() resolves.
    const run = async () => {
      const spec = data.__mithic_run;
      const deps = (spec.imports && typeof spec.imports === 'object') ? spec.imports : {};
      const importsMap = {};
      for (const name in deps) {
        if (typeof deps[name] !== 'string') continue;
        importsMap[name] = URL.createObjectURL(new Blob([deps[name]], { type: 'text/javascript' }));
      }
      Object.freeze(importsMap);
      __mithic_boot.imports = importsMap;
      let guestUrl = spec.guest;
      const minted = !spec.isUrl;
      if (minted) guestUrl = URL.createObjectURL(new Blob([spec.guest], { type: 'text/javascript' }));
      let mod;
      try {
        mod = await import(guestUrl);
      } finally {
        if (minted) URL.revokeObjectURL(guestUrl);
      }
      const entry = (mod && typeof mod.default === 'function') ? mod.default : globalThis.__mithic_default;
      if (typeof entry === 'function') await Promise.resolve(entry(__mithic_boot));
    };
    run().catch((err) => postMessage({ __mithic_error: String(err) }));
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
      // SECURITY (spec §3.5): spawn the worker from a `data:` URL carrying ONLY the fixed
      // bootstrap, NOT a host-page `blob:` URL. Rationale: the browser is moving data:-URL
      // workers to a UNIQUE OPAQUE (null) origin — Chrome "Opaque origin for data: URLs"
      // (kDataUrlWorkerOpaqueOrigin, Chrome 150+, HTML-spec-aligned). Spawning from `data:`
      // means our workers inherit that isolation AUTOMATICALLY once it ships: they can no
      // longer reach the host origin's cookies/IndexedDB/caches/same-origin fetch. A host-page
      // `blob:` worker (URL.createObjectURL on the host page) inherits the host origin and does
      // NOT get the opaque origin — it would remain same-origin FOREVER. So `data:` is strictly
      // correct even though, in browsers WITHOUT the flag yet, self.origin is still the host
      // origin (a documented transitional state; outbound egress is an accepted residual, §3.5a).
      // The bootstrap is tiny + fixed, so the `data:` length limit is a non-issue; the guest +
      // deps arrive as boot-message bytes and become in-sandbox blob: modules (stage 2). Do NOT
      // revert to a host-page blob: spawn to "optimize" this — it permanently forfeits the fix.
      const workerUrl = `data:text/javascript,${encodeURIComponent(bootstrapSrc)}`;
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

    const isUrl = typeof code !== 'string';
    const guest = isUrl ? (code instanceof URL ? code.href : String(code)) : code;

    const worker = this.#factory.create(BOOTSTRAP_SOURCE);
    const entry: WorkerEntry = { worker, callbacks: [] };
    this.#processes.set(id, entry);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as SyscallRequest;
      for (const cb of entry.callbacks) {
        cb(msg);
      }
    };

    // Always deliver the boot metadata (__mithic_init); attach the transfer list
    // only when there are ports. A guest with no ports still learns its
    // args/env/cwd/pid from boot.init instead of silently receiving null.
    // K2: preopenFds (when present) maps the stdio ports to arbitrary guest fds.
    const hasPorts = options.transfer != null && options.transfer.length > 0;
    worker.postMessage(
      { __mithic_init: options.init, ports: options.transfer ?? [], preopenFds: options.preopenFds },
      hasPorts ? options.transfer : undefined,
    );

    // OF1/G2: send guest source + dep source-texts as DATA (not a string to eval).
    worker.postMessage({ __mithic_run: { guest, isUrl, imports: options.guestImports ?? {} } });

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
