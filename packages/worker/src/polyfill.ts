import { isMainThread, parentPort, workerData, Worker as NodeWorker, type Transferable } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function setupWorkerGlobals() {
  const port = parentPort!;
  const queue: MessageEvent[] = [];
  let handler: ((e: MessageEvent) => void) | null = null;

  Object.defineProperty(globalThis, 'onmessage', {
    get: () => handler,
    set: (fn: ((e: MessageEvent) => void) | null) => {
      handler = fn;
      if (fn && queue.length > 0) {
        const pending = queue.splice(0);
        for (const msg of pending) fn(msg);
      }
    },
    configurable: true,
  });

  (globalThis as unknown as Record<string, unknown>).postMessage = (data: unknown, transfer?: Transferable[]) => {
    if (transfer) {
      port.postMessage(data, transfer);
    } else {
      port.postMessage(data);
    }
  };

  (globalThis as unknown as Record<string, unknown>).close = () => {
    port.postMessage({ __worker_close: true });
    process.exit(0);
  };

  (globalThis as unknown as Record<string, unknown>).self = globalThis;

  port.on('message', (data: unknown) => {
    const event = new MessageEvent('message', { data });
    if (handler) {
      handler(event);
    } else {
      queue.push(event);
    }
  });
}

if (!isMainThread && !('onmessage' in globalThis)) {
  // Worker side: set up Web Worker globals
  setupWorkerGlobals();

  const mod = workerData?.mod;
  if (mod) {
    // Bootstraped - import target module
    await import(mod);
  }
} else if (isMainThread && typeof globalThis.Worker === 'undefined') {
  // Main side: register Web Worker polyfill
  const polyfillPath = fileURLToPath(import.meta.url);

  class WebWorker extends EventTarget {
    #worker: InstanceType<typeof NodeWorker>;
    #onmessage: ((e: MessageEvent) => void) | null = null;
    #onerror: ((e: ErrorEvent) => void) | null = null;

    get onmessage() { return this.#onmessage; }
    set onmessage(fn: ((e: MessageEvent) => void) | null) { this.#onmessage = fn; }

    get onerror() { return this.#onerror; }
    set onerror(fn: ((e: ErrorEvent) => void) | null) { this.#onerror = fn; }

    constructor(url: string | URL, options?: WorkerOptions) {
      super();
      let modUrl: string;
      if (url instanceof URL) {
        modUrl = url.href;
      } else if (url.startsWith('file://') || url.startsWith('data:')) {
        modUrl = url;
      } else if (url.startsWith('/')) {
        modUrl = pathToFileURL(url).href;
      } else {
        modUrl = pathToFileURL(resolve(process.cwd(), url)).href;
      }

      this.#worker = new NodeWorker(polyfillPath, {
        workerData: { mod: modUrl, name: options?.name, type: options?.type },
      });

      let closeFired = false;
      const fireClose = () => {
        if (closeFired) return;
        closeFired = true;
        this.dispatchEvent(new Event('close'));
      };

      this.#worker.on('message', (data: unknown) => {
        if (data && typeof data === 'object' && '__worker_close' in data) {
          fireClose();
          return;
        }
        const event = new MessageEvent('message', { data });
        if (this.#onmessage) this.#onmessage(event);
        this.dispatchEvent(event);
      });

      this.#worker.on('error', (err: Error) => {
        const event = new ErrorEvent('error', { message: err.message, error: err });
        if (this.#onerror) this.#onerror(event);
        this.dispatchEvent(event);
      });

      this.#worker.on('exit', () => {
        fireClose();
      });
    }

    postMessage(data: unknown, transfer?: Transferable[]) {
      if (transfer) {
        this.#worker.postMessage(data, transfer);
      } else {
        this.#worker.postMessage(data);
      }
    }

    terminate() {
      return this.#worker.terminate();
    }
  }

  (globalThis as unknown as Record<string, unknown>).Worker = WebWorker;
}
