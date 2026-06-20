import type { SyscallRequest, SyscallResponse, KernelEvent, Signal } from '@mithic/protocol';
import {
  IFRAME_CAPABILITIES,
  type Runtime,
  type RuntimeCapabilities,
  type ProcessHandle,
  type SpawnOptions,
} from '../runtime.ts';
import { buildSrcdoc } from './iframe-bootstrap.ts';

interface IframeEntry {
  iframe: HTMLIFrameElement;
  messageListener: (e: MessageEvent) => void;
  callbacks: ((msg: SyscallRequest) => void)[];
}

/**
 * IframeRuntime spawns guest code inside a sandboxed <iframe> element.
 *
 * The iframe is created with `sandbox="allow-scripts"` — no `allow-same-origin` —
 * so the guest runs in an opaque origin and cannot access parent DOM or storage.
 *
 * Communication protocol (matches WorkerRuntime exactly):
 *  1. spawn() posts { __mithic_init, ports } with transferList to the iframe's contentWindow
 *  2. spawn() posts { __mithic_run: codeStr } to trigger evaluation
 *  3. Inbound messages from the iframe are routed to onMessage() callbacks
 *  4. postMessage() sends a message down to the iframe
 *  5. kill() / dispose() removes the iframe from the DOM
 *
 * Display modes:
 *  - 'hidden' (default): iframe is appended to document.body with display:none
 *  - 'inline': iframe is appended to document.body, sized per options.display
 *  - 'window' / 'fullscreen': treated same as inline for now
 */
export class IframeRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = IFRAME_CAPABILITIES;

  #nextId = 1;
  #processes = new Map<number, IframeEntry>();
  /** DOM node visible (non-hidden) iframes are appended to. Defaults to document.body. */
  #container: HTMLElement | undefined;

  /**
   * @param options.container Where visible (`display.mode !== 'hidden'`) iframes are
   *   mounted. Defaults to `document.body`. Hidden iframes always go on `document.body`
   *   off-screen. A host (e.g. the notebook) passes a results pane here so inline GUI
   *   processes render in place.
   */
  constructor(options: { container?: HTMLElement } = {}) {
    this.#container = options.container;
  }

  async spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;

    let codeStr: string;
    if (typeof code === 'string') {
      codeStr = code;
    } else {
      // URL reference: generate a dynamic import expression wrapped in an async IIFE.
      // A static `import mod from "..."` declaration is NOT valid inside eval(), so we
      // use a dynamic `await import(url)` expression instead — matching worker.ts behavior.
      const url = code instanceof URL ? code.href : String(code);
      codeStr = `(async () => {
        const mod = await import(${JSON.stringify(url)});
        if (typeof mod.default === 'function') {
          globalThis.__mithic_default = mod.default;
        }
      })();`;
    }

    // Create the sandboxed iframe
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = buildSrcdoc();

    // Apply display mode styling
    const displayMode = options.display?.mode ?? 'hidden';
    if (displayMode === 'hidden') {
      iframe.style.display = 'none';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = 'none';
      iframe.style.position = 'absolute';
    } else {
      iframe.style.width = options.display?.width != null ? `${options.display.width}px` : '100%';
      iframe.style.height = options.display?.height != null ? `${options.display.height}px` : '100%';
      iframe.style.border = 'none';
    }

    const callbacks: ((msg: SyscallRequest) => void)[] = [];

    // Listen for messages from this iframe; use window.onmessage filtering by source.
    // We capture the iframe reference in a closure so we can match the source.
    const messageListener = (e: MessageEvent) => {
      // Only accept messages from this iframe's contentWindow.
      // If contentWindow is null (iframe not yet in DOM), reject all messages to
      // avoid accidentally admitting messages from unrelated windows.
      if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
      const msg = e.data as SyscallRequest;
      for (const cb of callbacks) {
        cb(msg);
      }
    };

    window.addEventListener('message', messageListener);

    const entry: IframeEntry = { iframe, messageListener, callbacks };
    this.#processes.set(id, entry);

    // Append to DOM so the iframe gets a browsing context and can execute scripts.
    // Hidden iframes always live off-screen on document.body; visible ones go into
    // the configured container (defaults to document.body) so a host can place them.
    const mount = displayMode === 'hidden' ? document.body : (this.#container ?? document.body);
    mount.appendChild(iframe);

    // Wait for the iframe to load its srcdoc before posting messages
    await new Promise<void>((resolve) => {
      if (iframe.contentDocument?.readyState === 'complete') {
        resolve();
        return;
      }
      iframe.addEventListener('load', () => resolve(), { once: true });
    });

    // Deliver boot object: __mithic_init + transfer list [controlPort, stdinPort, stdoutPort, stderrPort, ...]
    // K2: preopenFds (when present) maps the stdio ports to arbitrary guest fds.
    if (options.transfer && options.transfer.length > 0) {
      iframe.contentWindow!.postMessage(
        { __mithic_init: options.init, ports: options.transfer, preopenFds: options.preopenFds },
        '*',
        options.transfer as Transferable[],
      );
    }

    iframe.contentWindow!.postMessage({ __mithic_run: codeStr }, '*');

    return { id };
  }

  kill(handle: ProcessHandle, _signal: Signal): void {
    this.#removeProcess(handle.id);
  }

  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, transfer?: Transferable[]): void {
    const entry = this.#processes.get(handle.id);
    if (entry?.iframe.contentWindow) {
      entry.iframe.contentWindow.postMessage(msg, '*', transfer ?? []);
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
    this.#removeProcess(handle.id);
  }

  #removeProcess(id: number): void {
    const entry = this.#processes.get(id);
    if (entry) {
      window.removeEventListener('message', entry.messageListener);
      entry.iframe.remove();
      this.#processes.delete(id);
    }
  }
}
