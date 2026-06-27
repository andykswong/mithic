# @mithic/desktop

> Host-side window manager for a Mithic browser OS — frames, drag/resize, z-order, taskbar, and an app registry, with **zero third-party dependencies**.

`@mithic/desktop` is the windowing/desktop-shell layer that turns a Mithic `Kernel` into a multi-window "browser OS". It is **host-side only** — it runs on the trusted host page, never inside a sandbox, and depends only on the public `Kernel` surface (`spawn`/`wait`/`kill`) plus host DOM. The guest never calls into it, so the capability boundary is preserved exactly as in Puter/OS.js.

It deliberately builds the window manager **from scratch** (no WinBox.js / react-rnd / tiling library): the package is a few hundred lines of vanilla TypeScript, keeping the TCB auditable and avoiding libraries that fight the no-reparent invariant (below).

## The two-tier window model

Every window is a frame (titlebar + content element) the WM owns; the two tiers differ only in what fills the content:

| Tier | Contents | Trust | Mechanism |
|------|----------|-------|-----------|
| **Tier-1 (host-rendered)** | First-party OS apps (terminal, editor, file manager) draw **host DOM** directly into `win.content`. | Trusted (part of the OS). | `AppDescriptor.mount(ctx, argv)` — the app uses the host `kernel`/`vfs` directly. |
| **Tier-2 (sandboxed)** | Untrusted / third-party apps run as **GUI guest processes** in opaque-origin iframes. | Untrusted. | `AppDescriptor.entry` (inline source or URL) → `kernel.spawn(entry, { display:{ mode:'window', container: win.content }, capabilities })`. |

The WM treats both uniformly; only tier-2 windows carry a `pid` and are torn down with `SIGTERM` on close.

## The non-negotiable invariants

These are what make a *sandboxed-iframe* window manager actually work — get them wrong and the desktop breaks:

1. **The iframe is never reparented.** Moving an iframe in the DOM destroys + reloads its document (WHATWG spec), which would kill the guest process and its kernel pipes. Each window frame is `appendChild`'d into the desktop **once, for life**; all movement/resize/restack is CSS (`transform: translate3d` + width/height) on the frame.
2. **Pointer-events shield during drag/resize.** The instant a gesture crosses any iframe, that iframe swallows the pointer events and the gesture breaks. `drag.ts` sets `pointer-events: none` on all iframes (a refcounted `body.mithic-wm-dragging` class) for the duration of every gesture, and routes `pointercancel` to cleanup so the shield can never get stuck on.
3. **Minimize = `display:none`** on the frame, never an unmount — so the guest survives (its timers throttle, which is desirable). Proven against a real tier-2 guest in `window-manager-real-kernel.browser.test.ts`.
4. **Z-order via a monotonic counter** (`z = ++topZ` on focus); a `window` blur bridge raises a tier-2 window when the user clicks inside its iframe.

## Modules

| Module | Responsibility |
|--------|----------------|
| `window-manager.ts` | `WindowManager` — open/close/focus/minimize/maximize, z-order, taskbar projection, tier-1 mount vs tier-2 spawn, geometry persistence. |
| `window.ts` | Window-frame chrome (titlebar + content + resize handle); `applyGeometry`/`applyState` (CSS-only). |
| `drag.ts` | `makeDraggable`/`makeResizable` with the refcounted iframe pointer-events shield. |
| `geometry.ts` | Pure helpers: `clampToBounds`, `cascadePlacement` (no DOM). |
| `app-registry.ts` | `AppRegistry` — name→app + file-extension→app associations (`resolveForFile`). |
| `persistence.ts` | `loadLayout`/`saveLayout` — per-app window geometry persisted to a `FileSystemProvider` (e.g. OPFS). |
| `apps/text-editor.ts` | A plain-`<textarea>` editor (no editor library) over an injected `EditorFs`. |
| `apps/file-manager.ts` | A two-pane tree+list file manager over an injected `FileManagerFs`: breadcrumb, back/forward, selection, context menu, drag-to-move, Open-With. |

## Usage

```ts
import { WindowManager, AppRegistry, mountTextEditor } from '@mithic/desktop';

const apps = new AppRegistry();
apps.register({ name: 'editor', title: 'Editor', defaultSize: [600, 420],
  mount: (ctx, argv) => mountTextEditor(ctx, argv, editorFs) });            // tier-1
apps.register({ name: 'viewer', title: 'Viewer', defaultSize: [480, 360],
  entry: VIEWER_GUEST_SRC, capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }] }); // tier-2
apps.associate('txt', 'editor');

const wm = new WindowManager({ desktop, taskbar, kernel, apps, storage: vfs });
await wm.open('editor', { argv: ['/notes.txt'] });
```

See `@mithic/example-desktop` for a complete bootable OS (terminal, editor, file manager, image viewer over one shared kernel + VFS).

## Window events & the minimal OS

The minimal OS needs **no new kernel events**: close maps to `SIGTERM` (the guest's `onSignal` runs cleanup), resize fires a **native** `resize` inside the guest (the iframe fills its frame at 100%), and focus is a host-side concern. Richer apps that need a JS focus/close-veto hook would use the deferred `window/*` `KernelEvent` extension (see `docs/isola/005-browser-os-design.md` §6).

## Build & test

```sh
npm run build      # vite build into dist/
npm test           # vitest (node + Chromium browser projects)
npm run typecheck
npm run lint
```

Node tests cover the pure layers (geometry, app-registry, persistence, the file-manager model, the editor). Browser (Chromium/Playwright) tests cover the DOM layers and the load-bearing invariants: the drag-across-iframe pointer-shield regression, minimize-no-reload against a real guest, focus bridge, maximize/resize, and the tier-1/tier-2 lifecycle.

## License

MIT
