import type { Kernel } from '@mithic/kernel';
import type { FileSystemProvider } from '@mithic/io/vfs';
import type { AppDescriptor, MithicWindow, OpenOptions, WindowContext } from './types.ts';
import type { AppRegistry } from './app-registry.ts';
import { cascadePlacement, clampToBounds } from './geometry.ts';
import { loadLayout, saveLayout, type SavedLayout } from './persistence.ts';
import {
  createWindowFrame, applyGeometry, applyState, setWindowTitle,
  type WindowFrameElements,
} from './window.ts';
import { installShieldStyle, makeDraggable, makeResizable } from './drag.ts';

/** The slice of Kernel the WM needs (so tests can pass a fake). */
export interface WmKernel {
  spawn(code: string | URL, init: Record<string, unknown>): Promise<{ pid: number }>;
  wait(pid: number): Promise<{ code: number }>;
  kill(pid: number, signal: string): void;
}

export interface WindowManagerOptions {
  desktop: HTMLElement;
  kernel: WmKernel | Kernel;
  apps: AppRegistry;
  /** Optional taskbar element; if present, the WM renders an item per window. */
  taskbar?: HTMLElement;
  /**
   * Optional VFS for persisting per-app window geometry. When set, the WM
   * restores a window to its last saved rect (clamped to the desktop) and
   * re-saves on drag/resize end and on close. When absent, no persistence.
   */
  storage?: FileSystemProvider;
}

interface Tracked {
  window: MithicWindow;
  els: WindowFrameElements;
  app: AppDescriptor;
  disposers: Array<() => void>;
  closeCbs: Array<() => void | Promise<void>>;
  taskbarItem?: HTMLElement;
  /** Geometry to restore when un-maximizing. */
  restoreGeometry?: { x: number; y: number; w: number; h: number };
}

export class WindowManager {
  readonly #desktop: HTMLElement;
  readonly #kernel: WmKernel;
  readonly #apps: AppRegistry;
  readonly #taskbar: HTMLElement | undefined;
  /** WM-owned child of #taskbar holding the running-window chips (never clobbers siblings). */
  #itemsHost: HTMLElement | undefined;
  readonly #tracked = new Map<number, Tracked>();
  readonly #storage: FileSystemProvider | undefined;
  /** In-memory cache of the persisted layout (empty until #layoutReady resolves). */
  #savedLayout: SavedLayout = {};
  /** Resolves once the initial layout load completes (only when storage is set). */
  readonly #layoutReady: Promise<void>;
  #nextId = 1;
  #topZ = 100;
  #openedCount = 0;
  /** The host `window` whose blur tells us a tier-2 iframe took focus. */
  readonly #hostWindow: Window;
  /** Bound `window` blur handler; installed once, removed in dispose(). */
  readonly #onHostBlur: () => void;

  constructor(opts: WindowManagerOptions) {
    this.#desktop = opts.desktop;
    this.#kernel = opts.kernel as WmKernel;
    this.#apps = opts.apps;
    this.#taskbar = opts.taskbar;
    this.#storage = opts.storage;
    // Eagerly load the saved layout; open() awaits this before placing a window.
    this.#layoutReady = this.#storage
      ? loadLayout(this.#storage).then((l) => { this.#savedLayout = l; }, () => {})
      : Promise.resolve();
    installShieldStyle(opts.desktop.ownerDocument);

    // Focus bridge across the sandbox (§5.3(4)). Clicking INSIDE a tier-2 iframe
    // does not bubble a pointerdown to the host frame, but it DOES blur the top
    // `window` and set document.activeElement to that iframe. On the next tick we
    // check activeElement and, if it is a tracked window's content iframe, raise
    // that window. Deferred to a microtask because activeElement is not yet
    // updated synchronously when the blur fires.
    this.#hostWindow = opts.desktop.ownerDocument.defaultView ?? globalThis as unknown as Window;
    this.#onHostBlur = () => { queueMicrotask(() => this.#focusActiveIframe()); };
    this.#hostWindow.addEventListener('blur', this.#onHostBlur);
  }

  /** If the focused element is a tracked window's content iframe, raise it. */
  #focusActiveIframe(): void {
    const active = this.#desktop.ownerDocument.activeElement;
    if (!active || active.tagName !== 'IFRAME') return;
    for (const t of this.#tracked.values()) {
      if (t.window.content.contains(active)) { this.focus(t.window.id); return; }
    }
  }

  get windows(): MithicWindow[] {
    return [...this.#tracked.values()].map((t) => t.window);
  }

  async open(name: string, opts: OpenOptions = {}): Promise<MithicWindow> {
    const app = this.#apps.get(name);
    if (!app) throw new Error(`unknown app: ${name}`);

    // Singleton: focus the existing instance.
    if (app.singleton) {
      const existing = [...this.#tracked.values()].find((t) => t.app.name === name);
      if (existing) { this.focus(existing.window.id); return existing.window; }
    }

    if (this.#storage) await this.#layoutReady;
    const bounds = { w: this.#desktop.clientWidth || 1024, h: this.#desktop.clientHeight || 768 };
    const savedRect = this.#storage ? this.#savedLayout[app.name] : undefined;
    const geometry = savedRect
      ? clampToBounds(savedRect, bounds)
      : clampToBounds(cascadePlacement(this.#openedCount++, app.defaultSize, bounds), bounds);
    const id = this.#nextId++;
    const { window: win, els } = createWindowFrame(this.#desktop.ownerDocument, {
      id, title: app.title, geometry, resizable: app.resizable !== false,
    });

    const tracked: Tracked = { window: win, els, app, disposers: [], closeCbs: [] };
    this.#tracked.set(id, tracked);

    // Mount ONCE — never reparent (would reload a tier-2 iframe).
    this.#desktop.appendChild(win.frame);
    applyGeometry(win);
    applyState(win);
    this.focus(id);

    // Chrome wiring.
    els.closeBtn.addEventListener('click', () => this.close(id));
    els.minimizeBtn.addEventListener('click', () => this.minimize(id));
    els.maximizeBtn.addEventListener('click', () => this.toggleMaximize(id));
    win.frame.addEventListener('pointerdown', () => this.focus(id), true);

    tracked.disposers.push(makeDraggable(els.titlebar, {
      onStart: () => ({ x: win.geometry.x, y: win.geometry.y }),
      onMove: (x, y) => { win.geometry.x = x; win.geometry.y = y; applyGeometry(win); },
      onEnd: () => this.#persist(app, win),
    }));
    if (app.resizable !== false) {
      tracked.disposers.push(makeResizable(els.resizeHandle, {
        onStart: () => ({ w: win.geometry.w, h: win.geometry.h }),
        onMove: (w, h) => { win.geometry.w = w; win.geometry.h = h; applyGeometry(win); },
        onEnd: () => this.#persist(app, win),
      }));
    }

    this.#renderTaskbar();

    const ctx: WindowContext = {
      window: win,
      content: win.content,
      kernel: this.#kernel as Kernel,
      onClose: (cb) => { tracked.closeCbs.push(cb); },
      setTitle: (t) => { setWindowTitle(win, els, t); this.#renderTaskbar(); },
    };

    if (app.mount) {
      // Tier-1: host DOM.
      await app.mount(ctx, opts.argv ?? []);
    } else if (app.entry != null) {
      // Tier-2: sandboxed iframe guest mounted INTO win.content. The frame +
      // tracked entry were created above; if the spawn rejects we must remove
      // them (else a ghost frame leaks) and rethrow so the caller sees the error.
      let pid: number;
      try {
        ({ pid } = await this.#kernel.spawn(app.entry, {
          args: [app.name, ...(opts.argv ?? [])],
          capabilities: app.capabilities ?? [],
          display: {
            // Thread the app's declared display mode (from its manifest) so the
            // guest learns it via `guest.display`. A `hidden` app still gets a
            // frame today (its guest sees `available:false`); suppressing the
            // frame for hidden apps is a follow-up.
            mode: app.displayMode ?? 'window',
            container: win.content,
            width: win.geometry.w,
            height: win.geometry.h,
            title: app.title,
            ...opts.display,
          },
        }));
      } catch (err) {
        this.#removeFrame(id);
        throw err;
      }
      win.pid = pid;
      // Auto-close the window when the guest exits.
      void this.#kernel.wait(pid).then(() => {
        if (this.#tracked.has(id)) this.#removeFrame(id);
      });
    }

    return win;
  }

  focus(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    t.window.z = ++this.#topZ;
    t.window.frame.style.zIndex = String(t.window.z);
    this.#renderTaskbar();
  }

  minimize(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    t.window.state = 'minimized';
    applyState(t.window);
    this.#renderTaskbar();
  }

  restore(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    t.window.state = 'normal';
    applyState(t.window);
    this.focus(id);
  }

  toggleMaximize(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    const win = t.window;
    if (win.state === 'maximized') {
      win.state = 'normal';
      if (t.restoreGeometry) win.geometry = { ...t.restoreGeometry };
    } else {
      t.restoreGeometry = { ...win.geometry };
      win.state = 'maximized';
      win.geometry = { x: 0, y: 0, w: this.#desktop.clientWidth, h: this.#desktop.clientHeight };
    }
    applyGeometry(win);
    applyState(win);
  }

  /** Close a window: SIGTERM a tier-2 guest, run tier-1 onClose, then remove the frame. */
  close(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    this.#persist(t.app, t.window);
    if (t.window.pid != null) {
      this.#kernel.kill(t.window.pid, 'SIGTERM');
      // The wait() handler removes the frame on exit; also remove eagerly so the
      // UI is responsive (idempotent — #removeFrame guards on presence).
      this.#removeFrame(id);
    } else {
      for (const cb of t.closeCbs) { try { void cb(); } catch { /* ignore */ } }
      this.#removeFrame(id);
    }
  }

  dispose(): void {
    this.#hostWindow.removeEventListener('blur', this.#onHostBlur);
    for (const id of [...this.#tracked.keys()]) this.close(id);
    this.#itemsHost?.remove();
    this.#itemsHost = undefined;
  }

  /** Best-effort persist of a window's current geometry, keyed by app name. */
  #persist(app: AppDescriptor, win: MithicWindow): void {
    if (!this.#storage) return;
    this.#savedLayout[app.name] = { ...win.geometry };
    saveLayout(this.#storage, this.#savedLayout).catch(() => {});
  }

  #removeFrame(id: number): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    for (const d of t.disposers) d();
    t.window.frame.remove();
    t.taskbarItem?.remove();
    this.#tracked.delete(id);
    this.#renderTaskbar();
  }

  /** Lazily create (and return) the WM-owned running-items container inside #taskbar. */
  #itemsContainer(): HTMLElement | undefined {
    if (!this.#taskbar) return undefined;
    if (!this.#itemsHost || !this.#taskbar.contains(this.#itemsHost)) {
      const host = this.#desktop.ownerDocument.createElement('div');
      host.dataset.role = 'taskbar-items';
      host.style.cssText = 'display:flex;gap:4px;align-items:center;';
      this.#taskbar.appendChild(host);
      this.#itemsHost = host;
    }
    return this.#itemsHost;
  }

  #renderTaskbar(): void {
    const host = this.#itemsContainer();
    if (!host) return;
    host.textContent = '';   // clears ONLY the WM's own container, never sibling launcher/pinned regions
    const topId = [...this.#tracked.values()].reduce<number | undefined>(
      (top, t) => (
        t.window.state === 'minimized' ? top
          : top === undefined || t.window.z > this.#tracked.get(top)!.window.z ? t.window.id : top
      ),
      undefined,
    );
    for (const t of this.#tracked.values()) {
      const item = this.#desktop.ownerDocument.createElement('button');
      item.dataset.role = 'taskbar-item';
      item.dataset.id = String(t.window.id);
      // topId is already the top NON-minimized window (minimized are skipped above),
      // so a bare id match is sufficient for the focused marker.
      if (t.window.id === topId) item.dataset.focused = 'true';
      const icon = t.app.icon ? `${t.app.icon} ` : '';
      item.textContent = `${icon}${t.window.title}`;
      item.style.cssText = 'font:12px sans-serif;cursor:pointer;max-width:160px;overflow:hidden;text-overflow:ellipsis;'
        + 'border:none;border-radius:8px;padding:4px 10px;color:#cdd6f4;'
        + (t.window.id === topId ? 'background:#45475a;' : 'background:#313244;')
        + (t.window.state === 'minimized' ? 'opacity:.6;' : '');
      item.addEventListener('click', () => {
        if (t.window.state === 'minimized') this.restore(t.window.id);
        else this.focus(t.window.id);
      });
      t.taskbarItem = item;
      host.appendChild(item);
    }
  }
}
