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
 *  2. spawn() posts { __mithic_run: { guest, isUrl, imports } } to trigger the stage-2 blob load
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

    const isUrl = typeof code !== 'string';
    const guest = isUrl ? (code instanceof URL ? code.href : String(code)) : code;

    // Create the sandboxed iframe
    const iframe = document.createElement('iframe');

    // Apply display mode styling
    const displayMode = options.display?.mode ?? 'hidden';

    // sandbox="allow-scripts" (no allow-same-origin → opaque origin). A VISIBLE guest
    // may additionally opt into `allow-downloads` (product-surface Download button);
    // hidden compute guests never get it. The token only grants download initiation,
    // not same-origin/popups/navigation, so the opaque-origin threat model is unchanged.
    const sandboxTokens = ['allow-scripts'];
    if (displayMode !== 'hidden' && options.display?.allowDownloads === true) {
      sandboxTokens.push('allow-downloads');
    }
    iframe.setAttribute('sandbox', sandboxTokens.join(' '));
    iframe.srcdoc = buildSrcdoc(options.csp);

    if (displayMode === 'hidden') {
      iframe.style.display = 'none';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = 'none';
      iframe.style.position = 'absolute';
    } else if (displayMode === 'window' || displayMode === 'fullscreen') {
      // The window frame (or viewport) owns the pixel size; the iframe fills it.
      // Resizing the frame then fires a NATIVE resize inside the guest document.
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
    } else {
      // 'inline': sized by explicit width/height (or 100% fallback).
      iframe.style.width = options.display?.width != null ? `${options.display.width}px` : '100%';
      iframe.style.height = options.display?.height != null ? `${options.display.height}px` : '100%';
      iframe.style.border = 'none';
    }

    // Apply the window title (a11y + dev-tools labeling). The protocol carries it
    // and the desktop WM passes app.title; reflect it onto the element.
    if (options.display?.title != null) {
      iframe.title = options.display.title;
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

    // Hidden iframes always live off-screen on document.body. Visible iframes go
    // into the per-spawn container if supplied (window-manager frame), else the
    // runtime's shared container, else document.body.
    const mount = displayMode === 'hidden'
      ? document.body
      : (options.display?.container ?? this.#container ?? document.body);
    mount.appendChild(iframe);

    // Wait for the iframe to load its srcdoc before posting messages
    await new Promise<void>((resolve) => {
      if (iframe.contentDocument?.readyState === 'complete') {
        resolve();
        return;
      }
      iframe.addEventListener('load', () => resolve(), { once: true });
    });

    // Always deliver boot metadata; attach the transfer list only when non-empty.
    // K2: preopenFds (when present) maps the stdio ports to arbitrary guest fds.
    const hasPorts = options.transfer != null && options.transfer.length > 0;
    iframe.contentWindow!.postMessage(
      { __mithic_init: options.init, ports: options.transfer ?? [], preopenFds: options.preopenFds },
      '*',
      hasPorts ? (options.transfer as Transferable[]) : [],
    );

    // OF1/G2: send guest source + dep source-texts as DATA (not a string to eval).
    iframe.contentWindow!.postMessage(
      { __mithic_run: { guest, isUrl, imports: options.guestImports ?? {} } },
      '*',
    );

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
