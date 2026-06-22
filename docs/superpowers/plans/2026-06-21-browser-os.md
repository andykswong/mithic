# Mithic Browser OS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimalist browser OS on Mithic v2 — a window manager plus four apps (terminal, text editor, file manager, image viewer) — by adding a per-window iframe mount target to the runtime and a new host-side `@mithic/desktop` window-manager package, with zero kernel/protocol redesign.

**Architecture:** One shared `Kernel` + VFS backs every window. The WM is a host-side layer (`@mithic/desktop`) that owns window-frame DOM, drag/resize, z-order, focus, taskbar, and an app registry; the guest never participates in window management. GUI processes are sandboxed iframes mounted **directly inside their own window frame** (never reparented — reparenting reloads the iframe and kills the guest). First-party apps (terminal/editor/file-manager) render host DOM into the window content element (trusted, reuse existing wiring); the image-viewer is the reference sandboxed (iframe) app. No new kernel syscalls; the minimal OS needs no new kernel events (close=SIGTERM, resize=native iframe resize, focus=host-only).

**Tech Stack:** TypeScript 6 (ESM-only), Vite 8 (lib + app builds), Vitest 3.2 (node + Chromium/Playwright browser projects), xterm.js 6 (terminal only). No editor library (plain `<textarea>`). No WM library (WinBox.js studied as reference, not vendored). Node >= 26.

**Source design doc:** `docs/isola/005-browser-os-design.md` (in the sibling `docs` repo). This plan implements its **Phases 1–3** (the minimal OS).

---

## Scope boundary

**IN scope (this plan):**
- Phase 1 — runtime/kernel per-window `container` field + real `'window'`/`'fullscreen'` sizing in `IframeRuntime`.
- Phase 2 — `@mithic/desktop`: WindowManager, AppRegistry, taskbar, geometry persistence, pointer-shield drag/resize.
- Phase 3 — apps: terminal (reuse `bootShell`), `<textarea>` editor, file manager, image-viewer in a window; `@mithic/example-desktop` assembly; OPFS mounted at `/`; remove `examples/notebook`.

**OUT of scope (design doc Phase 4 — deferred, do NOT implement here):**
- Per-app `~/AppData/<id>` private mounts, file-picker consent syscall.
- Manifest-driven registry *auto-discovery* (we register apps explicitly in code; manifests stay declarative).
- `window/*` KernelEvents, `kernel.notifyWindow`, guest `onWindowEvent`.
- COOP/COEP credentialless-iframe hardening, sender-identity broker hardening beyond what already exists.
- Live-streaming stdio rewrite of the shell (`spawnStream`): the terminal reuses the **existing** `bootShell` capture/callback path verbatim. (A live-stdio upgrade is a separate follow-up; the design doc lists it as the one terminal "upgrade" but it is not required for a working terminal window and touches shell core.)

> **Decision recorded:** keeping the terminal on the existing `bootShell` path avoids dragging shell-core changes into a UI-layer plan. If live stdio is wanted, it is a standalone task after this plan lands.

---

## File structure

**New package — `@mithic/desktop` (`packages/desktop/`):** the reusable, dependency-free WM library.

| File | Responsibility |
|---|---|
| `packages/desktop/package.json` | Package manifest (`@mithic/desktop`, v2.0.0, deps on kernel/runtime/io/protocol). |
| `packages/desktop/tsconfig.json` | Extends root; `lib: ["esnext","dom"]`. |
| `packages/desktop/vite.config.ts` | Re-export root lib build. |
| `packages/desktop/eslint.config.mjs` | Re-use shared examples eslint shape. |
| `packages/desktop/src/index.ts` | Public barrel: `WindowManager`, `AppRegistry`, types. |
| `packages/desktop/src/geometry.ts` | Pure geometry helpers (clamp, default placement, cascade) — no DOM, node-testable. |
| `packages/desktop/src/window.ts` | `MithicWindow` — one window's frame DOM (titlebar + content), state, geometry application via CSS transform. |
| `packages/desktop/src/drag.ts` | Pointer-driven drag/resize with the iframe pointer-events shield. Pure-ish: takes callbacks, node-testable seams where possible. |
| `packages/desktop/src/window-manager.ts` | `WindowManager` — registry of windows, z-order/focus, open/close, taskbar projection, minimize/maximize. |
| `packages/desktop/src/app-registry.ts` | `AppRegistry` + `AppDescriptor` — name→app, tier-1 `mount` vs tier-2 `entry`. |
| `packages/desktop/src/persistence.ts` | Save/load window geometry to a `FileSystemProvider` (JSON at a fixed VFS path). |
| `packages/desktop/src/*.test.ts` | Node tests for pure logic (geometry, registry, persistence, z-order). |
| `packages/desktop/src/*.browser.test.ts` | Chromium tests for DOM (window frame, drag-across-iframe, minimize-no-reload). |

**New apps** (host-DOM modules; live in `@mithic/desktop` consumers or example):

| File | Responsibility |
|---|---|
| `packages/desktop/src/apps/text-editor.ts` | `mountTextEditor(win, deps)` — `<textarea>` editor over VFS. |
| `packages/desktop/src/apps/file-manager.ts` | `mountFileManager(win, deps)` — tree+list over VFS, context menu, open-with. |
| `packages/desktop/src/apps/text-editor.test.ts` / `.browser.test.ts` | Editor tests. |
| `packages/desktop/src/apps/file-manager.test.ts` / `.browser.test.ts` | File-manager tests. |

> **Decision:** the terminal app is a thin adapter over the existing `@mithic/example-shell` `bootShell`; it lives in the **example-desktop** package (it depends on xterm, which `@mithic/desktop` must not). The editor + file-manager are dependency-free and live in `@mithic/desktop/apps` so they're reusable + node/browser-testable inside the package.

**New example — `@mithic/example-desktop` (`packages/examples/desktop/`):** boots the whole OS.

| File | Responsibility |
|---|---|
| `packages/examples/desktop/package.json` | App package (deps: desktop, kernel, runtime, io, shell, coreutils, jq, curl, guest-runtime, xterm). |
| `packages/examples/desktop/index.html` | Desktop surface + taskbar mount points. |
| `packages/examples/desktop/vite.config.ts` | Same as example-shell (COOP/COEP dev headers, esnext). |
| `packages/examples/desktop/tsconfig.json` / `eslint.config.mjs` | Standard. |
| `packages/examples/desktop/src/boot.ts` | `bootDesktop(root)` — shared Kernel+VFS, register apps, mount WM. |
| `packages/examples/desktop/src/terminal-app.ts` | Tier-1 terminal app: `mountTerminal(win, kernel)` reusing `bootShell` internals. |
| `packages/examples/desktop/src/commands.ts` | Reuse the in-process command suite (copy of example-shell `createCommandSuite`). |
| `packages/examples/desktop/src/main.ts` | Page entry: `bootDesktop(document.getElementById('desktop'))`. |
| `packages/examples/desktop/src/*.browser.test.ts` | E2E: open terminal/editor/files/image-viewer windows; close; persist. |

**Modified:**
- `packages/runtime/src/runtime.ts` — add `display.container?: HTMLElement`.
- `packages/runtime/src/backends/iframe.ts` — honor per-spawn container; real `'window'`/`'fullscreen'` sizing.
- `packages/kernel/src/kernel.ts` — add `container?: HTMLElement` to `DisplayOptions`.
- `package.json` (root) — add `packages/desktop` + `packages/examples/desktop` to workspaces; remove `packages/examples/notebook`.
- `vitest.config.ts` — add desktop globs to node+browser include; swap `notebook`→`desktop` in the examples browser glob.

**Removed:**
- `packages/examples/notebook/` (whole package).

---

## Parallelization DAG (for the orchestrator)

Foundation is sequential; independent leaves fan out. Waves:

- **Wave 0 (sequential, single agent):** Task 1 (runtime+kernel container field) → Task 2 (scaffold `@mithic/desktop` package skeleton + workspace wiring + vitest globs) → Task 3 (scaffold `@mithic/example-desktop` skeleton + notebook removal). These touch shared root config (`package.json`, `vitest.config.ts`) and the build graph — they MUST land first and in order so parallel work compiles. After Wave 0: `npm install && npm run build` green.
- **Wave 1 (parallel, worktree-isolated — independent files in `@mithic/desktop/src`):**
  - 1A: `geometry.ts` (Task 4)
  - 1B: `app-registry.ts` (Task 5)
  - 1C: `persistence.ts` (Task 6)
  - 1D: `apps/text-editor.ts` (Task 8)
  - 1E: `apps/file-manager.ts` (Task 9)
  These have no inter-dependencies (editor/file-manager depend only on a small injected `FileSystemProvider`-shaped dep + the `MithicWindow` interface, which is defined in Task 4's sibling `window.ts` — so define the `MithicWindow`/`WindowContext` interfaces in Wave 0 Task 2's `index.ts` stub to unblock).
- **Wave 2 (depends on Wave 1):** `window.ts` (Task 7, needs geometry) → `drag.ts` (Task 10) → `window-manager.ts` (Task 11, needs window+registry+persistence+drag). Mostly sequential (one file feeds the next) but `drag.ts` can parallel with `window.ts`.
- **Wave 3 (depends on Wave 2 + apps):** `@mithic/example-desktop` wiring — `commands.ts` (Task 12), `terminal-app.ts` (Task 13), `boot.ts` (Task 14), `main.ts`+`index.html` (Task 15), E2E browser tests (Task 16).
- **Integration:** full root gate `npm run build && npm run typecheck && npm test`.
- **Review:** dedicated review subagent.

> Worktree isolation note: parallel agents editing **different new files** in the same package don't truly conflict, but each Wave-1 agent should still create + test its own file and run only its own test to stay fast; the orchestrator merges and runs the package build once per wave. The shared `index.ts` barrel is append-only per task to avoid churn — each task adds its own export line.

---
## Wave 0 — Foundation (sequential)

### Task 1: Per-window iframe container (runtime + kernel)

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (the `SpawnOptions.display` shape, ~line 31)
- Modify: `packages/runtime/src/backends/iframe.ts:77-116`
- Modify: `packages/kernel/src/kernel.ts:219-225` (`DisplayOptions`)
- Test: `packages/runtime/src/backends/iframe.browser.test.ts` (append cases)

- [ ] **Step 1: Write the failing browser test** — append to `packages/runtime/src/backends/iframe.browser.test.ts`:

```ts
test('IframeRuntime: window mode mounts into a per-spawn container and fills it', async () => {
  const runtime = new IframeRuntime(); // no shared container
  const frame = document.createElement('div');
  frame.style.width = '300px';
  frame.style.height = '200px';
  document.body.appendChild(frame);

  const ch = new MessageChannel();
  const handle = await runtime.spawn('globalThis.__post?.({ready:true});', {
    init: { entry: '', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
    transfer: [ch.port2],
    display: { mode: 'window', container: frame, width: 300, height: 200, title: 'T' },
  });

  // The iframe must be a child of the per-spawn frame, NOT document.body.
  const iframe = frame.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(iframe!.parentElement).toBe(frame);
  // Window mode fills the frame (100%), not a fixed px size.
  expect(iframe!.style.width).toBe('100%');
  expect(iframe!.style.height).toBe('100%');

  runtime.dispose(handle);
  frame.remove();
});

test('IframeRuntime: per-spawn container overrides the constructor container', async () => {
  const shared = document.createElement('div');
  document.body.appendChild(shared);
  const runtime = new IframeRuntime({ container: shared });
  const frame = document.createElement('div');
  document.body.appendChild(frame);

  const ch = new MessageChannel();
  const handle = await runtime.spawn('1;', {
    init: { entry: '', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [] },
    transfer: [ch.port2],
    display: { mode: 'window', container: frame },
  });

  expect(frame.querySelector('iframe')).not.toBeNull();
  expect(shared.querySelector('iframe')).toBeNull();

  runtime.dispose(handle);
  shared.remove(); frame.remove();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run --project browser packages/runtime/src/backends/iframe.browser.test.ts`
Expected: FAIL — `display.container` not a valid type (typecheck) and/or iframe mounted into `document.body` (the per-spawn container is ignored; `width`/`height` set to px not 100%).

- [ ] **Step 3: Add `container` to `SpawnOptions.display`** — in `packages/runtime/src/runtime.ts`, replace the `display?:` block (lines ~31-37) with:

```ts
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
```

- [ ] **Step 4: Honor the container + real window sizing in `iframe.ts`** — replace the display-styling block and the `mount` line (`packages/runtime/src/backends/iframe.ts:78-116`):

```ts
    // Apply display mode styling
    const displayMode = options.display?.mode ?? 'hidden';
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
```

And replace the `mount` line:

```ts
    // Hidden iframes always live off-screen on document.body. Visible iframes go
    // into the per-spawn container if supplied (window-manager frame), else the
    // runtime's shared container, else document.body.
    const mount = displayMode === 'hidden'
      ? document.body
      : (options.display?.container ?? this.#container ?? document.body);
    mount.appendChild(iframe);
```

- [ ] **Step 5: Mirror the field on the kernel `DisplayOptions`** — in `packages/kernel/src/kernel.ts`, replace the `DisplayOptions` interface (lines 219-225):

```ts
/** GUI display placement, mirroring `SpawnOptions.display` on the runtime. */
export interface DisplayOptions {
  mode: 'hidden' | 'inline' | 'window' | 'fullscreen';
  width?: number;
  height?: number;
  title?: string;
  /** Host-side per-window mount target; see runtime `SpawnOptions.display.container`. */
  container?: HTMLElement;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run build && npx vitest run --project browser packages/runtime/src/backends/iframe.browser.test.ts`
Expected: PASS (all iframe browser cases, including the two new ones).

- [ ] **Step 7: Verify no kernel spawn-path change was needed** — confirm `Kernel.spawn` still forwards `init.display` unchanged:

Run: `grep -n "display" packages/kernel/src/kernel.ts`
Expected: `display: init.display` at ~:593 and `display: ctx.display` at ~:1289 still present, untouched.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/backends/iframe.ts packages/kernel/src/kernel.ts packages/runtime/src/backends/iframe.browser.test.ts
git commit -m "feat(runtime,kernel): per-window iframe container + real window-mode sizing"
```

### Task 2: Scaffold `@mithic/desktop` package + shared interfaces + workspace/vitest wiring

**Files:**
- Create: `packages/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.mjs`
- Create: `packages/desktop/src/index.ts` (barrel)
- Create: `packages/desktop/src/types.ts` (the WM/app interfaces every Wave-1 file imports)
- Modify: `package.json` (root workspaces), `vitest.config.ts` (include globs)

- [ ] **Step 1: Create `packages/desktop/package.json`**

```json
{
  "name": "@mithic/desktop",
  "version": "2.0.0",
  "private": true,
  "description": "Mithic browser-OS window manager — host-side, dependency-free (frames, drag/resize, z-order, taskbar, app registry)",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["/dist"],
  "scripts": {
    "clean": "rimraf dist *.tsbuildinfo",
    "build": "vite build",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "repository": { "type": "git", "url": "git+https://github.com/andykswong/mithic.git" },
  "author": "Andy K.S. Wong <andykswong@outlook.com>",
  "license": "MIT",
  "dependencies": {
    "@mithic/protocol": "2.0.0",
    "@mithic/io": "2.0.0",
    "@mithic/kernel": "2.0.0",
    "@mithic/runtime": "2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/desktop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["esnext", "dom"],
    "types": ["node"],
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["./src"]
}
```

- [ ] **Step 3: Create `packages/desktop/vite.config.ts`**

```ts
export { default } from '../../vite.config.ts';
```

- [ ] **Step 4: Create `packages/desktop/eslint.config.mjs`**

```js
import eslint from '@eslint/js';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['**/dist/*'] },
  eslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
  },
];
```

- [ ] **Step 5: Create `packages/desktop/src/types.ts`** — the interfaces every other file imports (defined up front so Wave-1 files compile independently):

```ts
import type { Kernel, DisplayOptions } from '@mithic/kernel';
import type { Capability } from '@mithic/protocol';

/** A rectangle in desktop pixels. */
export interface Rect { x: number; y: number; w: number; h: number; }

export type WindowState = 'normal' | 'minimized' | 'maximized';

/** One open window: its chrome DOM, geometry, and lifecycle. */
export interface MithicWindow {
  readonly id: number;
  pid?: number;
  title: string;
  /** The chrome root (titlebar + content), mounted in the desktop surface for life. */
  readonly frame: HTMLElement;
  /** Where host DOM (tier-1) or the guest iframe (tier-2) lives. */
  readonly content: HTMLElement;
  state: WindowState;
  geometry: Rect;
  z: number;
}

/** Handed to a tier-1 app's mount() — the app draws into `content`. */
export interface WindowContext {
  readonly window: MithicWindow;
  readonly content: HTMLElement;
  readonly kernel: Kernel;
  /** Register cleanup to run when the window closes. */
  onClose(cb: () => void | Promise<void>): void;
  /** Set the window title (updates titlebar + taskbar). */
  setTitle(title: string): void;
}

/** A registered app. Exactly one of `mount` (tier-1 host DOM) or `entry` (tier-2 iframe guest). */
export interface AppDescriptor {
  name: string;
  title: string;
  icon?: string;
  defaultSize: [number, number];
  resizable?: boolean;
  singleton?: boolean;
  capabilities?: Capability[];
  /** Tier-1: render host DOM into the window. */
  mount?: (ctx: WindowContext, argv: string[]) => void | Promise<void>;
  /** Tier-2: sandboxed iframe guest entry (inline source string or URL). */
  entry?: string | URL;
}

/** Options for opening a window. */
export interface OpenOptions {
  argv?: string[];
  display?: Partial<DisplayOptions>;
}
```

- [ ] **Step 6: Create `packages/desktop/src/index.ts`** — barrel (append-only as later tasks land):

```ts
export type {
  Rect, WindowState, MithicWindow, WindowContext, AppDescriptor, OpenOptions,
} from './types.ts';
```

- [ ] **Step 7: Add to root workspaces** — in `package.json`, in `workspaces`, add `"./packages/desktop"` immediately before `"./packages/examples/shell"`.

- [ ] **Step 8: Add desktop globs to `vitest.config.ts`** — in the node project `include` array add after the `commands/*` line:

```ts
            'packages/desktop/src/**/*.test.ts',
```

In the browser project `include` array add:

```ts
            'packages/desktop/src/**/*.browser.test.ts',
```

(Leave the `examples/{...}` browser glob for Task 3.)

- [ ] **Step 9: Install + build + verify the empty package compiles**

Run: `npm install && npm run build`
Expected: PASS — `@mithic/desktop` builds, workspace resolves.

- [ ] **Step 10: Commit**

```bash
git add packages/desktop package.json vitest.config.ts package-lock.json
git commit -m "chore(desktop): scaffold @mithic/desktop package + shared WM interfaces"
```

### Task 3: Scaffold `@mithic/example-desktop` + remove `examples/notebook`

**Files:**
- Create: `packages/examples/desktop/{package.json,tsconfig.json,vite.config.ts,eslint.config.mjs,index.html}`
- Create: `packages/examples/desktop/src/main.ts` (stub)
- Remove: `packages/examples/notebook/` (whole dir)
- Modify: `package.json` (workspaces), `vitest.config.ts` (examples browser glob)

- [ ] **Step 1: Create `packages/examples/desktop/package.json`**

```json
{
  "name": "@mithic/example-desktop",
  "version": "2.0.0",
  "private": true,
  "description": "Mithic example — a minimalist browser OS: window manager + terminal, text editor, file manager, image viewer",
  "type": "module",
  "scripts": {
    "clean": "rimraf dist *.tsbuildinfo",
    "build": "vite build",
    "dev": "vite",
    "start": "vite preview",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "repository": { "type": "git", "url": "git+https://github.com/andykswong/mithic.git" },
  "author": "Andy K.S. Wong <andykswong@outlook.com>",
  "license": "MIT",
  "dependencies": {
    "@mithic/coreutils": "2.0.0",
    "@mithic/curl": "2.0.0",
    "@mithic/desktop": "2.0.0",
    "@mithic/guest-runtime": "2.0.0",
    "@mithic/io": "2.0.0",
    "@mithic/jq": "2.0.0",
    "@mithic/kernel": "2.0.0",
    "@mithic/runtime": "2.0.0",
    "@mithic/shell": "2.0.0",
    "@xterm/addon-fit": "^0.11",
    "@xterm/addon-web-links": "^0.12",
    "@xterm/xterm": "^6.0"
  }
}
```

- [ ] **Step 2: Create `packages/examples/desktop/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "lib": ["esnext", "dom"],
    "types": ["node"],
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["./src"]
}
```

- [ ] **Step 3: Create `packages/examples/desktop/vite.config.ts`** (mirror example-shell)

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  worker: { format: 'es' },
  build: { target: 'esnext', outDir: 'dist' },
  base: './',
});
```

- [ ] **Step 4: Create `packages/examples/desktop/eslint.config.mjs`** — identical content to Task 2 Step 4.

- [ ] **Step 5: Create `packages/examples/desktop/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>mithic OS</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; overflow: hidden; font-family: ui-sans-serif, system-ui, sans-serif; }
      #desktop { position: relative; height: calc(100% - 36px); width: 100%; background: #1e1e2e; overflow: hidden; }
      #taskbar { position: fixed; bottom: 0; left: 0; right: 0; height: 36px; display: flex; gap: 4px; align-items: center; padding: 0 6px; background: #11111b; }
    </style>
  </head>
  <body>
    <div id="desktop"></div>
    <div id="taskbar"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `packages/examples/desktop/src/main.ts`** (stub — fleshed out in Task 15)

```ts
// Page entry. Filled in by Task 15 (bootDesktop). Stub keeps the package buildable.
export {};
```

- [ ] **Step 7: Remove the notebook package**

```bash
git rm -r packages/examples/notebook
```

- [ ] **Step 8: Update root workspaces** — in `package.json`, remove the `"./packages/examples/notebook"` line and add `"./packages/examples/desktop"`.

- [ ] **Step 9: Update the examples browser glob in `vitest.config.ts`** — change `{image-viewer,notebook,shell}` to `{image-viewer,desktop,shell}`. Keep the xterm `optimizeDeps` pre-bundle.

- [ ] **Step 10: Install + full build + verify nothing references the notebook**

Run: `npm install && npm run build && grep -rn "example-notebook\|examples/notebook" packages vitest.config.ts package.json --include='*.ts' --include='*.json' | grep -v node_modules | grep -v package-lock`
Expected: build PASS; grep returns nothing.

- [ ] **Step 11: Run the full gate to confirm a green baseline before parallel work**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS (notebook tests gone; new empty packages have no tests yet — `passWithNoTests` is on).

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore(examples): scaffold @mithic/example-desktop; remove broken example-notebook"
```

---
## Wave 1 — Independent leaf modules (parallel)

> All Wave-1 tasks import only `./types.ts` (Task 2) and standard libs. They create distinct files and append one export line each to `index.ts`. Run only your own test during the task; the orchestrator runs the package build once per wave.

### Task 4: Geometry helpers (`geometry.ts`)

**Files:**
- Create: `packages/desktop/src/geometry.ts`
- Test: `packages/desktop/src/geometry.test.ts`
- Modify: `packages/desktop/src/index.ts` (append export)

- [ ] **Step 1: Write the failing test** — `packages/desktop/src/geometry.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { clampToBounds, cascadePlacement, DEFAULT_MIN_SIZE } from './geometry.ts';
import type { Rect } from './types.ts';

const bounds = { w: 1000, h: 800 };

describe('clampToBounds', () => {
  test('keeps an in-bounds rect unchanged', () => {
    const r: Rect = { x: 100, y: 100, w: 300, h: 200 };
    expect(clampToBounds(r, bounds)).toEqual(r);
  });
  test('pulls an off-right/bottom rect back inside', () => {
    const r: Rect = { x: 900, y: 700, w: 300, h: 200 };
    expect(clampToBounds(r, bounds)).toEqual({ x: 700, y: 600, w: 300, h: 200 });
  });
  test('clamps negative origin to 0', () => {
    expect(clampToBounds({ x: -50, y: -20, w: 100, h: 100 }, bounds)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
  test('clamps a too-large size to the bounds and enforces min size', () => {
    const out = clampToBounds({ x: 0, y: 0, w: 5000, h: 5000 }, bounds);
    expect(out.w).toBe(1000);
    expect(out.h).toBe(800);
    const tiny = clampToBounds({ x: 0, y: 0, w: 1, h: 1 }, bounds);
    expect(tiny.w).toBe(DEFAULT_MIN_SIZE.w);
    expect(tiny.h).toBe(DEFAULT_MIN_SIZE.h);
  });
});

describe('cascadePlacement', () => {
  test('places the first window near the top-left', () => {
    expect(cascadePlacement(0, [400, 300], bounds)).toEqual({ x: 24, y: 24, w: 400, h: 300 });
  });
  test('offsets each subsequent window by a step', () => {
    expect(cascadePlacement(2, [400, 300], bounds)).toEqual({ x: 24 + 2 * 28, y: 24 + 2 * 28, w: 400, h: 300 });
  });
  test('wraps the cascade when it would overflow the bounds', () => {
    const r = cascadePlacement(40, [400, 300], bounds);
    expect(r.x).toBeGreaterThanOrEqual(24);
    expect(r.x + r.w).toBeLessThanOrEqual(bounds.w);
    expect(r.y + r.h).toBeLessThanOrEqual(bounds.h);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project node packages/desktop/src/geometry.test.ts`
Expected: FAIL — `geometry.ts` not found / exports undefined.

- [ ] **Step 3: Write `packages/desktop/src/geometry.ts`**

```ts
import type { Rect } from './types.ts';

/** Smallest allowed window size (px). */
export const DEFAULT_MIN_SIZE = { w: 160, h: 100 } as const;

/** Cascade origin + per-window step (px). */
const CASCADE_ORIGIN = 24;
const CASCADE_STEP = 28;

/** Available desktop area. */
export interface Bounds { w: number; h: number; }

/**
 * Clamp a rect so it fits inside `bounds`: enforce the min size, cap the size at
 * the bounds, then pull the origin so the rect stays fully visible (origin >= 0).
 */
export function clampToBounds(r: Rect, bounds: Bounds): Rect {
  const w = Math.min(Math.max(r.w, DEFAULT_MIN_SIZE.w), bounds.w);
  const h = Math.min(Math.max(r.h, DEFAULT_MIN_SIZE.h), bounds.h);
  const x = Math.min(Math.max(r.x, 0), Math.max(0, bounds.w - w));
  const y = Math.min(Math.max(r.y, 0), Math.max(0, bounds.h - h));
  return { x, y, w, h };
}

/**
 * Default placement for the Nth opened window: a diagonal cascade from the
 * top-left, wrapping back to the origin (modulo) before it would overflow.
 */
export function cascadePlacement(index: number, size: [number, number], bounds: Bounds): Rect {
  const [w, h] = size;
  const maxStepsX = Math.max(1, Math.floor((bounds.w - w - CASCADE_ORIGIN) / CASCADE_STEP));
  const maxStepsY = Math.max(1, Math.floor((bounds.h - h - CASCADE_ORIGIN) / CASCADE_STEP));
  const steps = Math.min(maxStepsX, maxStepsY);
  const n = steps > 0 ? index % steps : 0;
  return clampToBounds(
    { x: CASCADE_ORIGIN + n * CASCADE_STEP, y: CASCADE_ORIGIN + n * CASCADE_STEP, w, h },
    bounds,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project node packages/desktop/src/geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { clampToBounds, cascadePlacement, DEFAULT_MIN_SIZE } from './geometry.ts';
export type { Bounds } from './geometry.ts';
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/geometry.ts packages/desktop/src/geometry.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): geometry helpers (clamp, cascade placement)"
```

### Task 5: App registry (`app-registry.ts`)

**Files:**
- Create: `packages/desktop/src/app-registry.ts`
- Test: `packages/desktop/src/app-registry.test.ts`
- Modify: `packages/desktop/src/index.ts`

- [ ] **Step 1: Write the failing test** — `packages/desktop/src/app-registry.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { AppRegistry } from './app-registry.ts';
import type { AppDescriptor } from './types.ts';

const editor: AppDescriptor = { name: 'editor', title: 'Editor', defaultSize: [600, 400], mount: () => {} };
const viewer: AppDescriptor = { name: 'viewer', title: 'Viewer', defaultSize: [800, 600], entry: 'code;' };

describe('AppRegistry', () => {
  test('register + get + list', () => {
    const r = new AppRegistry();
    r.register(editor);
    r.register(viewer);
    expect(r.get('editor')).toBe(editor);
    expect(r.list().map((a) => a.name).sort()).toEqual(['editor', 'viewer']);
  });
  test('get returns undefined for unknown app', () => {
    expect(new AppRegistry().get('nope')).toBeUndefined();
  });
  test('rejects a descriptor with neither mount nor entry', () => {
    const r = new AppRegistry();
    expect(() => r.register({ name: 'bad', title: 'B', defaultSize: [1, 1] }))
      .toThrow(/must declare exactly one of `mount` or `entry`/);
  });
  test('rejects a descriptor with BOTH mount and entry', () => {
    const r = new AppRegistry();
    expect(() => r.register({ name: 'bad', title: 'B', defaultSize: [1, 1], mount: () => {}, entry: 'x' }))
      .toThrow(/must declare exactly one of `mount` or `entry`/);
  });
  test('rejects duplicate registration', () => {
    const r = new AppRegistry();
    r.register(editor);
    expect(() => r.register(editor)).toThrow(/already registered: editor/);
  });
  test('resolveForFile maps an extension to a registered app name', () => {
    const r = new AppRegistry();
    r.register(editor);
    r.register(viewer);
    r.associate('txt', 'editor');
    r.associate('png', 'viewer');
    expect(r.resolveForFile('/a/b/notes.txt')?.name).toBe('editor');
    expect(r.resolveForFile('/x/pic.PNG')?.name).toBe('viewer'); // case-insensitive
    expect(r.resolveForFile('/x/unknown.zzz')).toBeUndefined();
    expect(r.resolveForFile('/x/noext')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project node packages/desktop/src/app-registry.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write `packages/desktop/src/app-registry.ts`**

```ts
import type { AppDescriptor } from './types.ts';

/**
 * The set of installed apps + file-type associations. Pure data + lookups; the
 * WindowManager consumes it to launch apps and resolve "Open With".
 */
export class AppRegistry {
  readonly #apps = new Map<string, AppDescriptor>();
  /** lowercase extension (no dot) → app name */
  readonly #assoc = new Map<string, string>();

  register(app: AppDescriptor): void {
    const hasMount = typeof app.mount === 'function';
    const hasEntry = app.entry != null;
    if (hasMount === hasEntry) {
      throw new Error(`app "${app.name}" must declare exactly one of \`mount\` or \`entry\``);
    }
    if (this.#apps.has(app.name)) {
      throw new Error(`app already registered: ${app.name}`);
    }
    this.#apps.set(app.name, app);
  }

  get(name: string): AppDescriptor | undefined {
    return this.#apps.get(name);
  }

  list(): AppDescriptor[] {
    return [...this.#apps.values()];
  }

  /** Associate a file extension (with or without leading dot) to an app name. */
  associate(ext: string, appName: string): void {
    this.#assoc.set(normalizeExt(ext), appName);
  }

  /** Resolve the app that should open `path`, by its extension. */
  resolveForFile(path: string): AppDescriptor | undefined {
    const ext = extOf(path);
    if (!ext) return undefined;
    const name = this.#assoc.get(ext);
    return name ? this.#apps.get(name) : undefined;
  }
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

function extOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined; // no ext, or dotfile with no ext
  return base.slice(dot + 1).toLowerCase();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project node packages/desktop/src/app-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { AppRegistry } from './app-registry.ts';
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/app-registry.ts packages/desktop/src/app-registry.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): app registry + file-type associations"
```

### Task 6: Window-geometry persistence (`persistence.ts`)

**Files:**
- Create: `packages/desktop/src/persistence.ts`
- Test: `packages/desktop/src/persistence.test.ts`
- Modify: `packages/desktop/src/index.ts`

- [ ] **Step 1: Write the failing test** — `packages/desktop/src/persistence.test.ts` (uses a real `MemoryFsProvider`, the same `FileSystemProvider` shape the WM uses):

```ts
import { describe, expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { loadLayout, saveLayout, LAYOUT_PATH } from './persistence.ts';

async function freshVfs() {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return vfs;
}

describe('layout persistence', () => {
  test('loadLayout returns {} when no file exists', async () => {
    const vfs = await freshVfs();
    expect(await loadLayout(vfs)).toEqual({});
  });
  test('saveLayout then loadLayout round-trips geometry by app name', async () => {
    const vfs = await freshVfs();
    const layout = { editor: { x: 10, y: 20, w: 600, h: 400 }, files: { x: 0, y: 0, w: 800, h: 500 } };
    await saveLayout(vfs, layout);
    expect(await loadLayout(vfs)).toEqual(layout);
  });
  test('loadLayout tolerates a corrupt file (returns {})', async () => {
    const vfs = await freshVfs();
    const h = await vfs.open(LAYOUT_PATH, { write: true, create: true, truncate: true });
    await vfs.write(h, new TextEncoder().encode('not json{'), 0);
    await vfs.close(h);
    expect(await loadLayout(vfs)).toEqual({});
  });
  test('saveLayout overwrites a prior layout', async () => {
    const vfs = await freshVfs();
    await saveLayout(vfs, { a: { x: 1, y: 1, w: 1, h: 1 } });
    await saveLayout(vfs, { b: { x: 2, y: 2, w: 2, h: 2 } });
    expect(await loadLayout(vfs)).toEqual({ b: { x: 2, y: 2, w: 2, h: 2 } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project node packages/desktop/src/persistence.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/persistence.ts`**

```ts
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import type { Rect } from './types.ts';

/** Where the WM stores per-app window geometry. */
export const LAYOUT_PATH = '/.mithic-desktop/layout.json';

/** Saved geometry keyed by app name (last-window-wins for singletons). */
export type SavedLayout = Record<string, Rect>;

/** Read the saved layout; returns `{}` if absent or unparseable. */
export async function loadLayout(vfs: FileSystemProvider): Promise<SavedLayout> {
  let handle: FileHandle;
  try {
    handle = (await vfs.open(LAYOUT_PATH, { read: true })) as FileHandle;
  } catch {
    return {};
  }
  try {
    const chunks: Uint8Array[] = [];
    let off = 0;
    for (;;) {
      const c = await vfs.read(handle, off, 65536);
      if (!c || c.byteLength === 0) break;
      chunks.push(new Uint8Array(c));
      off += c.byteLength;
    }
    const text = new TextDecoder().decode(concat(chunks));
    const parsed = JSON.parse(text) as unknown;
    return isLayout(parsed) ? parsed : {};
  } catch {
    return {};
  } finally {
    await vfs.close(handle).catch(() => {});
  }
}

/** Persist the layout, creating parent dir + file as needed. */
export async function saveLayout(vfs: FileSystemProvider, layout: SavedLayout): Promise<void> {
  const dir = LAYOUT_PATH.slice(0, LAYOUT_PATH.lastIndexOf('/'));
  try { await vfs.mkdir(dir); } catch { /* exists */ }
  const handle = (await vfs.open(LAYOUT_PATH, { write: true, create: true, truncate: true })) as FileHandle;
  try {
    await vfs.write(handle, new TextEncoder().encode(JSON.stringify(layout)), 0);
  } finally {
    await vfs.close(handle).catch(() => {});
  }
}

function isLayout(x: unknown): x is SavedLayout {
  if (typeof x !== 'object' || x === null) return false;
  for (const v of Object.values(x)) {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    if (['x', 'y', 'w', 'h'].some((k) => typeof r[k] !== 'number')) return false;
  }
  return true;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0; for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project node packages/desktop/src/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { loadLayout, saveLayout, LAYOUT_PATH } from './persistence.ts';
export type { SavedLayout } from './persistence.ts';
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/persistence.ts packages/desktop/src/persistence.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): window-geometry persistence to the VFS"
```

---
### Task 8: Text editor app (`apps/text-editor.ts`)

**Files:**
- Create: `packages/desktop/src/apps/text-editor.ts`
- Test: `packages/desktop/src/apps/text-editor.test.ts` (node, DOM logic via jsdom-free pure render fn) and `packages/desktop/src/apps/text-editor.browser.test.ts`
- Modify: `packages/desktop/src/index.ts`

> **Design:** the editor is a pure DOM builder `renderTextEditor(doc, deps)` returning a handle, plus a thin `mountTextEditor(ctx, argv)` adapter that wires it to a window. File I/O goes through a tiny injected `EditorFs` interface (subset of `FileSystemProvider`) so node tests can drive it with a fake and the browser test with a real `MemoryFsProvider`. No editor library — a `<textarea>`.

- [ ] **Step 1: Write the failing node test** — `packages/desktop/src/apps/text-editor.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { renderTextEditor, type EditorFs } from './text-editor.ts';

// Minimal fake document so the pure render fn is node-testable without jsdom.
function fakeDoc() {
  const make = () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const el: any = {
      tagName: '', style: {}, children: [] as any[], value: '', textContent: '', readOnly: false,
      dataset: {}, className: '',
      appendChild(c: any) { this.children.push(c); return c; },
      addEventListener(t: string, cb: (e: unknown) => void) { (listeners[t] ??= []).push(cb); },
      dispatch(t: string, e: unknown = {}) { (listeners[t] ?? []).forEach((cb) => cb(e)); },
      querySelector() { return null; },
      remove() {},
      focus() {},
    };
    return el;
  };
  return { createElement: (tag: string) => { const el = make(); el.tagName = tag.toUpperCase(); return el; } } as unknown as Document;
}

function memFs(initial: Record<string, string> = {}): EditorFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async readFile(path) { if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[path]; },
    async writeFile(path, text) { files[path] = text; },
  };
}

describe('renderTextEditor', () => {
  test('loads file content into the textarea', async () => {
    const fs = memFs({ '/a.txt': 'hello' });
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt' });
    await h.ready;
    expect(h.textarea.value).toBe('hello');
    expect(h.dirty).toBe(false);
  });
  test('starts empty (no dirty) for a nonexistent path', async () => {
    const fs = memFs();
    const h = renderTextEditor(fakeDoc(), { fs, path: '/new.txt' });
    await h.ready;
    expect(h.textarea.value).toBe('');
    expect(h.dirty).toBe(false);
  });
  test('edits set dirty; save writes to fs and clears dirty', async () => {
    const fs = memFs({ '/a.txt': 'x' });
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt' });
    await h.ready;
    h.textarea.value = 'changed';
    (h.textarea as any).dispatch('input');
    expect(h.dirty).toBe(true);
    await h.save();
    expect(fs.files['/a.txt']).toBe('changed');
    expect(h.dirty).toBe(false);
  });
  test('readOnly disables editing and the save path', async () => {
    const fs = memFs({ '/a.txt': 'x' });
    const save = vi.spyOn(fs, 'writeFile');
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt', readOnly: true });
    await h.ready;
    expect(h.textarea.readOnly).toBe(true);
    await h.save();
    expect(save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project node packages/desktop/src/apps/text-editor.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/apps/text-editor.ts`**

```ts
import type { WindowContext } from '../types.ts';

/** The narrow file-I/O surface the editor needs (subset of FileSystemProvider semantics). */
export interface EditorFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface EditorDeps {
  fs: EditorFs;
  path: string;
  readOnly?: boolean;
}

export interface EditorHandle {
  readonly textarea: HTMLTextAreaElement;
  readonly root: HTMLElement;
  /** Resolves once the initial file load has completed. */
  readonly ready: Promise<void>;
  dirty: boolean;
  save(): Promise<void>;
}

/**
 * Build the editor DOM (toolbar + <textarea>) into a fresh root element and wire
 * load/save/dirty. Pure DOM — no window/kernel coupling, so it is node-testable
 * with a fake document. `mountTextEditor` adapts it to a real window.
 */
export function renderTextEditor(doc: Document, deps: EditorDeps): EditorHandle {
  const root = doc.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:#1e1e2e;color:#cdd6f4;';

  const bar = doc.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:4px 8px;font:12px sans-serif;background:#181825;';
  const label = doc.createElement('span');
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = 'Save';
  bar.appendChild(label);
  bar.appendChild(saveBtn);

  const textarea = doc.createElement('textarea') as HTMLTextAreaElement;
  textarea.style.cssText = 'flex:1 1 auto;width:100%;height:100%;resize:none;border:none;outline:none;'
    + 'font:13px ui-monospace,Menlo,monospace;background:#1e1e2e;color:#cdd6f4;padding:8px;';
  textarea.readOnly = !!deps.readOnly;

  root.appendChild(bar);
  root.appendChild(textarea);

  const handle: EditorHandle = {
    textarea, root, dirty: false, ready: Promise.resolve(),
    async save() {
      if (deps.readOnly) return;
      await deps.fs.writeFile(deps.path, textarea.value);
      handle.dirty = false;
      updateLabel();
    },
  };

  const updateLabel = (): void => {
    label.textContent = `${deps.path}${handle.dirty ? ' *' : ''}${deps.readOnly ? ' (read-only)' : ''}`;
  };

  // Tab inserts a tab char rather than moving focus.
  textarea.addEventListener('keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      markDirty();
    }
    // Ctrl/Cmd+S saves.
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      void handle.save();
    }
  });

  const markDirty = (): void => {
    if (deps.readOnly || handle.dirty) return;
    handle.dirty = true;
    updateLabel();
  };
  textarea.addEventListener('input', markDirty);
  saveBtn.addEventListener('click', () => { void handle.save(); });

  // Initial load.
  handle.ready = (async () => {
    let text = '';
    try { text = await deps.fs.readFile(deps.path); } catch { text = ''; }
    textarea.value = text;
    handle.dirty = false;
    updateLabel();
  })();

  updateLabel();
  return handle;
}

/** Adapt a WindowContext into a mounted editor. `argv[0]` is the file path. */
export function mountTextEditor(ctx: WindowContext, argv: string[], fs: EditorFs): EditorHandle {
  const path = argv[0] ?? '/untitled.txt';
  const h = renderTextEditor(ctx.content.ownerDocument, { fs, path });
  ctx.content.appendChild(h.root);
  ctx.setTitle(`Editor — ${path}`);
  ctx.onClose(() => {
    if (h.dirty && typeof confirm === 'function' && !confirm(`Discard unsaved changes to ${path}?`)) {
      // Best-effort: a real WM may veto; for the minimal OS we just warn and proceed.
    }
  });
  return h;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project node packages/desktop/src/apps/text-editor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the browser test** — `packages/desktop/src/apps/text-editor.browser.test.ts` (real DOM):

```ts
import { expect, test } from 'vitest';
import { renderTextEditor, type EditorFs } from './text-editor.ts';

function memFs(initial: Record<string, string> = {}): EditorFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async readFile(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    async writeFile(p, t) { files[p] = t; },
  };
}

test('editor renders a textarea into real DOM and round-trips save', async () => {
  const fs = memFs({ '/n.txt': 'abc' });
  const h = renderTextEditor(document, { fs, path: '/n.txt' });
  document.body.appendChild(h.root);
  await h.ready;
  const ta = h.root.querySelector('textarea')!;
  expect(ta).not.toBeNull();
  expect(ta.value).toBe('abc');

  ta.value = 'abcd';
  ta.dispatchEvent(new Event('input'));
  expect(h.dirty).toBe(true);
  await h.save();
  expect(fs.files['/n.txt']).toBe('abcd');
  expect(h.dirty).toBe(false);

  h.root.remove();
});
```

- [ ] **Step 6: Run the browser test**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/apps/text-editor.browser.test.ts`
Expected: PASS.

- [ ] **Step 7: Append the export to `index.ts`**

```ts
export { renderTextEditor, mountTextEditor } from './apps/text-editor.ts';
export type { EditorFs, EditorDeps, EditorHandle } from './apps/text-editor.ts';
```

- [ ] **Step 8: Commit**

```bash
git add packages/desktop/src/apps/text-editor.ts packages/desktop/src/apps/text-editor.test.ts packages/desktop/src/apps/text-editor.browser.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): plain-textarea text editor app (no editor library)"
```

### Task 9: File manager app (`apps/file-manager.ts`)

**Files:**
- Create: `packages/desktop/src/apps/file-manager.ts`
- Test: `packages/desktop/src/apps/file-manager.test.ts` (node) + `packages/desktop/src/apps/file-manager.browser.test.ts`
- Modify: `packages/desktop/src/index.ts`

> **Design:** a pure `renderFileManager(doc, deps)` returning a handle that exposes the current listing + navigation/actions, plus `mountFileManager`. File ops go through an injected `FileManagerFs` (list/stat/mkdir/remove/rename) so node tests use a fake. "Open With" is a callback `onOpen(path)` the WM wires to launch the associated app. No dependency.

- [ ] **Step 1: Write the failing node test** — `packages/desktop/src/apps/file-manager.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { createFileManagerModel, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) { const p = parent(from); const e = (tree[p] ?? []).find((x) => x.name === base(from)); if (e) e.name = base(to); },
  };
}
const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

describe('file manager model', () => {
  test('lists the cwd sorted dirs-first then name', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [
      { name: 'b.txt', kind: 'file' }, { name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' },
    ] }), onOpen: () => {} });
    await m.navigate('/');
    expect(m.entries.map((e) => e.name)).toEqual(['docs', 'a.txt', 'b.txt']);
    expect(m.cwd).toBe('/');
  });
  test('navigate into a subdir and back via up()', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }], '/docs': [{ name: 'x.txt', kind: 'file' }] }), onOpen: () => {} });
    await m.navigate('/');
    await m.enter('docs');
    expect(m.cwd).toBe('/docs');
    expect(m.entries.map((e) => e.name)).toEqual(['x.txt']);
    await m.up();
    expect(m.cwd).toBe('/');
  });
  test('opening a file delegates to onOpen with the absolute path', async () => {
    const onOpen = vi.fn();
    const m = createFileManagerModel({ fs: fakeFs({ '/': [{ name: 'a.txt', kind: 'file' }] }), onOpen });
    await m.navigate('/');
    await m.open('a.txt');
    expect(onOpen).toHaveBeenCalledWith('/a.txt');
  });
  test('newFolder / newFile / remove / rename mutate and refresh', async () => {
    const fs = fakeFs({ '/': [] });
    const m = createFileManagerModel({ fs, onOpen: () => {} });
    await m.navigate('/');
    await m.newFolder('sub'); expect(m.entries.some((e) => e.name === 'sub' && e.kind === 'directory')).toBe(true);
    await m.newFile('f.txt'); expect(m.entries.some((e) => e.name === 'f.txt')).toBe(true);
    await m.rename('f.txt', 'g.txt'); expect(m.entries.some((e) => e.name === 'g.txt')).toBe(true);
    await m.remove('g.txt'); expect(m.entries.some((e) => e.name === 'g.txt')).toBe(false);
  });
  test('up() at root is a no-op', async () => {
    const m = createFileManagerModel({ fs: fakeFs({ '/': [] }), onOpen: () => {} });
    await m.navigate('/');
    await m.up();
    expect(m.cwd).toBe('/');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project node packages/desktop/src/apps/file-manager.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/apps/file-manager.ts`**

```ts
import type { WindowContext } from '../types.ts';

export interface Entry { name: string; kind: 'file' | 'directory'; size?: number; }

/** The file ops the manager needs (absolute paths). */
export interface FileManagerFs {
  list(path: string): Promise<Entry[]>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface FileManagerDeps {
  fs: FileManagerFs;
  /** Launch the app associated with a file (WM wires this to "Open With"). */
  onOpen(path: string): void;
}

export interface FileManagerModel {
  readonly cwd: string;
  readonly entries: Entry[];
  navigate(path: string): Promise<void>;
  enter(name: string): Promise<void>;
  up(): Promise<void>;
  open(name: string): Promise<void>;
  newFolder(name: string): Promise<void>;
  newFile(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p: string): string => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');

/** Sort: directories first, then files; each alphabetical (case-insensitive). */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/** The headless model — navigation + actions, no DOM. Node-testable. */
export function createFileManagerModel(deps: FileManagerDeps): FileManagerModel {
  let cwd = '/';
  let entries: Entry[] = [];
  const refresh = async (): Promise<void> => { entries = sortEntries(await deps.fs.list(cwd)); };

  const model: FileManagerModel = {
    get cwd() { return cwd; },
    get entries() { return entries; },
    async navigate(path) { cwd = path; await refresh(); },
    async enter(name) { cwd = join(cwd, name); await refresh(); },
    async up() { cwd = parentOf(cwd); await refresh(); },
    async open(name) { deps.onOpen(join(cwd, name)); },
    async newFolder(name) { await deps.fs.mkdir(join(cwd, name)); await refresh(); },
    async newFile(name) { await deps.fs.createFile(join(cwd, name)); await refresh(); },
    async remove(name) { await deps.fs.remove(join(cwd, name)); await refresh(); },
    async rename(from, to) { await deps.fs.rename(join(cwd, from), join(cwd, to)); await refresh(); },
  };
  return model;
}

export interface FileManagerHandle {
  readonly root: HTMLElement;
  readonly model: FileManagerModel;
  readonly ready: Promise<void>;
}

/**
 * Render a minimal two-pane DOM (breadcrumb + list) driven by the model. Each
 * row: double-click a directory enters it, double-click a file opens it.
 * Buttons: Up, New Folder, New File. Right-click row → rename/delete via prompt.
 */
export function renderFileManager(doc: Document, deps: FileManagerDeps): FileManagerHandle {
  const model = createFileManagerModel(deps);
  const root = doc.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:#1e1e2e;color:#cdd6f4;font:13px sans-serif;';

  const bar = doc.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:6px;align-items:center;padding:4px 8px;background:#181825;';
  const crumb = doc.createElement('span');
  crumb.style.cssText = 'flex:1 1 auto;font:12px ui-monospace,monospace;';
  const upBtn = button(doc, 'Up');
  const mkdirBtn = button(doc, 'New Folder');
  const mkfileBtn = button(doc, 'New File');
  bar.append(upBtn, mkdirBtn, mkfileBtn, crumb);

  const list = doc.createElement('div');
  list.style.cssText = 'flex:1 1 auto;overflow:auto;';

  root.append(bar, list);

  const draw = (): void => {
    crumb.textContent = model.cwd;
    list.textContent = '';
    for (const e of model.entries) {
      const row = doc.createElement('div');
      row.dataset.name = e.name;
      row.dataset.kind = e.kind;
      row.style.cssText = 'padding:4px 10px;cursor:default;user-select:none;';
      row.textContent = `${e.kind === 'directory' ? '📁' : '📄'} ${e.name}`;
      row.addEventListener('dblclick', () => {
        void (async () => {
          if (e.kind === 'directory') { await model.enter(e.name); draw(); }
          else { await model.open(e.name); }
        })();
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const action = typeof prompt === 'function' ? prompt(`${e.name}: type "rename" or "delete"`) : null;
        void (async () => {
          if (action === 'delete') { await model.remove(e.name); draw(); }
          else if (action === 'rename') {
            const to = prompt('New name:', e.name);
            if (to) { await model.rename(e.name, to); draw(); }
          }
        })();
      });
      list.appendChild(row);
    }
  };

  upBtn.addEventListener('click', () => { void model.up().then(draw); });
  mkdirBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('Folder name:') : null;
    if (name) void model.newFolder(name).then(draw);
  });
  mkfileBtn.addEventListener('click', () => {
    const name = typeof prompt === 'function' ? prompt('File name:') : null;
    if (name) void model.newFile(name).then(draw);
  });

  const ready = model.navigate('/').then(draw);
  return { root, model, ready };
}

function button(doc: Document, text: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.textContent = text;
  b.style.cssText = 'font:12px sans-serif;cursor:pointer;';
  return b;
}

/** Adapt to a window. */
export function mountFileManager(ctx: WindowContext, deps: FileManagerDeps): FileManagerHandle {
  const h = renderFileManager(ctx.content.ownerDocument, deps);
  ctx.content.appendChild(h.root);
  ctx.setTitle('Files');
  return h;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project node packages/desktop/src/apps/file-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the browser test** — `packages/desktop/src/apps/file-manager.browser.test.ts`:

```ts
import { expect, test } from 'vitest';
import { renderFileManager, type FileManagerFs, type Entry } from './file-manager.ts';

function fakeFs(tree: Record<string, Entry[]>): FileManagerFs {
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return {
    async list(path) { return tree[path] ? [...tree[path]] : []; },
    async mkdir(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'directory' }); },
    async createFile(path) { (tree[parent(path)] ??= []).push({ name: base(path), kind: 'file' }); },
    async remove(path) { const p = parent(path); tree[p] = (tree[p] ?? []).filter((e) => e.name !== base(path)); },
    async rename(from, to) { const p = parent(from); const e = (tree[p] ?? []).find((x) => x.name === base(from)); if (e) e.name = base(to); },
  };
}

test('file manager renders rows and opens a file on dblclick', async () => {
  const opened: string[] = [];
  const h = renderFileManager(document, {
    fs: fakeFs({ '/': [{ name: 'docs', kind: 'directory' }, { name: 'a.txt', kind: 'file' }] }),
    onOpen: (p) => opened.push(p),
  });
  document.body.appendChild(h.root);
  await h.ready;

  const rows = h.root.querySelectorAll('[data-name]');
  expect(rows.length).toBe(2);
  // dirs first
  expect((rows[0] as HTMLElement).dataset.name).toBe('docs');

  const fileRow = h.root.querySelector('[data-name="a.txt"]') as HTMLElement;
  fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await Promise.resolve();
  expect(opened).toEqual(['/a.txt']);

  h.root.remove();
});
```

- [ ] **Step 6: Run the browser test**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/apps/file-manager.browser.test.ts`
Expected: PASS.

- [ ] **Step 7: Append the export to `index.ts`**

```ts
export { createFileManagerModel, renderFileManager, mountFileManager } from './apps/file-manager.ts';
export type { Entry, FileManagerFs, FileManagerDeps, FileManagerModel, FileManagerHandle } from './apps/file-manager.ts';
```

- [ ] **Step 8: Commit**

```bash
git add packages/desktop/src/apps/file-manager.ts packages/desktop/src/apps/file-manager.test.ts packages/desktop/src/apps/file-manager.browser.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): file manager app (tree+list, open-with, no dependency)"
```

---
## Wave 2 — Window-frame DOM, drag, and the WindowManager

> Depends on Wave 1 (geometry, registry, persistence, app interfaces). `window.ts` (Task 7) and `drag.ts` (Task 10) are independent of each other and can run in parallel; `window-manager.ts` (Task 11) depends on both plus the registry/persistence.

### Task 7: Window frame DOM (`window.ts`)

**Files:**
- Create: `packages/desktop/src/window.ts`
- Test: `packages/desktop/src/window.browser.test.ts`
- Modify: `packages/desktop/src/index.ts`

> **Design:** `createWindowFrame(doc, opts)` builds the chrome (titlebar with title + minimize/maximize/close buttons, content area), returns `{ window, els }` where `window` implements `MithicWindow`. `applyGeometry(window)` writes geometry via `transform: translate3d` + width/height (CSS only — never reparent). Geometry/state are plain fields; the WM mutates them and calls `applyGeometry`/`applyState`.

- [ ] **Step 1: Write the failing browser test** — `packages/desktop/src/window.browser.test.ts`:

```ts
import { expect, test } from 'vitest';
import { createWindowFrame, applyGeometry, applyState } from './window.ts';

test('createWindowFrame builds titlebar + content and reflects title', () => {
  const { window: win, els } = createWindowFrame(document, { id: 1, title: 'Hello', geometry: { x: 10, y: 20, w: 300, h: 200 } });
  document.body.appendChild(win.frame);

  expect(win.frame.querySelector('[data-role="titlebar"]')).not.toBeNull();
  expect(win.content).toBe(win.frame.querySelector('[data-role="content"]'));
  expect(els.titleText.textContent).toBe('Hello');
  expect(els.closeBtn).toBeTruthy();
  expect(els.minimizeBtn).toBeTruthy();
  expect(els.maximizeBtn).toBeTruthy();

  win.frame.remove();
});

test('applyGeometry positions the frame via transform + size', () => {
  const { window: win } = createWindowFrame(document, { id: 2, title: 'G', geometry: { x: 40, y: 50, w: 320, h: 240 } });
  document.body.appendChild(win.frame);
  applyGeometry(win);
  expect(win.frame.style.transform).toBe('translate3d(40px, 50px, 0px)');
  expect(win.frame.style.width).toBe('320px');
  expect(win.frame.style.height).toBe('240px');
  win.frame.remove();
});

test('applyState: minimized hides via display:none (frame stays in DOM)', () => {
  const { window: win } = createWindowFrame(document, { id: 3, title: 'M', geometry: { x: 0, y: 0, w: 200, h: 150 } });
  document.body.appendChild(win.frame);
  win.state = 'minimized';
  applyState(win);
  expect(win.frame.style.display).toBe('none');
  // Crucial: the frame is NOT removed from the DOM (so a child iframe would survive).
  expect(win.frame.isConnected).toBe(true);

  win.state = 'normal';
  applyState(win);
  expect(win.frame.style.display).not.toBe('none');
  win.frame.remove();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/window.browser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/window.ts`**

```ts
import type { MithicWindow, Rect } from './types.ts';

export interface WindowFrameElements {
  titlebar: HTMLElement;
  titleText: HTMLElement;
  minimizeBtn: HTMLButtonElement;
  maximizeBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  resizeHandle: HTMLElement;
}

export interface CreateWindowOptions {
  id: number;
  title: string;
  geometry: Rect;
  resizable?: boolean;
}

/** Build the window chrome (titlebar + content + resize handle). Pure DOM. */
export function createWindowFrame(
  doc: Document,
  opts: CreateWindowOptions,
): { window: MithicWindow; els: WindowFrameElements } {
  const frame = doc.createElement('div');
  frame.dataset.role = 'window';
  frame.dataset.id = String(opts.id);
  frame.style.cssText = 'position:absolute;top:0;left:0;display:flex;flex-direction:column;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.4);border-radius:6px;overflow:hidden;background:#1e1e2e;'
    + 'will-change:transform;';

  const titlebar = doc.createElement('div');
  titlebar.dataset.role = 'titlebar';
  titlebar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;'
    + 'background:#313244;color:#cdd6f4;font:12px sans-serif;cursor:move;user-select:none;';
  const titleText = doc.createElement('span');
  titleText.dataset.role = 'title';
  titleText.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  titleText.textContent = opts.title;

  const minimizeBtn = chromeButton(doc, '–');
  const maximizeBtn = chromeButton(doc, '□');
  const closeBtn = chromeButton(doc, '✕');
  titlebar.append(titleText, minimizeBtn, maximizeBtn, closeBtn);

  const content = doc.createElement('div');
  content.dataset.role = 'content';
  content.style.cssText = 'flex:1 1 auto;position:relative;overflow:hidden;background:#1e1e2e;';

  const resizeHandle = doc.createElement('div');
  resizeHandle.dataset.role = 'resize';
  resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;'
    + (opts.resizable === false ? 'display:none;' : '');

  frame.append(titlebar, content, resizeHandle);

  const window: MithicWindow = {
    id: opts.id,
    title: opts.title,
    frame,
    content,
    state: 'normal',
    geometry: { ...opts.geometry },
    z: 0,
  };

  return { window, els: { titlebar, titleText, minimizeBtn, maximizeBtn, closeBtn, resizeHandle } };
}

/** Write geometry to the frame via transform (compositor-friendly) + size. CSS only. */
export function applyGeometry(win: MithicWindow): void {
  const { x, y, w, h } = win.geometry;
  win.frame.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
  win.frame.style.width = `${w}px`;
  win.frame.style.height = `${h}px`;
}

/** Reflect window state: minimized = display:none (frame stays mounted, so a child iframe survives). */
export function applyState(win: MithicWindow): void {
  win.frame.style.display = win.state === 'minimized' ? 'none' : 'flex';
}

/** Update the visible title (titlebar). */
export function setWindowTitle(win: MithicWindow, els: WindowFrameElements, title: string): void {
  win.title = title;
  els.titleText.textContent = title;
}

function chromeButton(doc: Document, glyph: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.textContent = glyph;
  b.style.cssText = 'flex:0 0 auto;width:20px;height:20px;border:none;border-radius:4px;cursor:pointer;'
    + 'background:transparent;color:inherit;font:12px sans-serif;line-height:1;';
  return b;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/window.browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { createWindowFrame, applyGeometry, applyState, setWindowTitle } from './window.ts';
export type { WindowFrameElements, CreateWindowOptions } from './window.ts';
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/window.ts packages/desktop/src/window.browser.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): window-frame chrome + CSS-only geometry/state"
```

### Task 10: Drag/resize with the iframe pointer-events shield (`drag.ts`)

**Files:**
- Create: `packages/desktop/src/drag.ts`
- Test: `packages/desktop/src/drag.browser.test.ts`
- Modify: `packages/desktop/src/index.ts`

> **Design (the load-bearing detail):** during a drag/resize gesture, set `pointer-events:none` on ALL window iframes (via a body class) so the gesture survives the pointer crossing any iframe; remove on pointerup. `makeDraggable(handle, opts)` and `makeResizable(handle, opts)` attach pointerdown listeners and drive `onMove(rect)` callbacks; they call `beginShield()`/`endShield()`. Shield management is a tiny module-level helper toggling a body class whose CSS the WM injects.

- [ ] **Step 1: Write the failing browser test** — `packages/desktop/src/drag.browser.test.ts`:

```ts
import { expect, test } from 'vitest';
import { makeDraggable, SHIELD_CLASS, installShieldStyle } from './drag.ts';

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
}

test('dragging the handle reports new positions and toggles the iframe shield', () => {
  installShieldStyle(document);
  const handle = document.createElement('div');
  document.body.appendChild(handle);

  const moves: Array<{ dx: number; dy: number }> = [];
  makeDraggable(handle, {
    onStart: () => ({ x: 100, y: 100 }),
    onMove: (x, y) => { moves.push({ dx: x, dy: y }); },
  });

  handle.dispatchEvent(pointer('pointerdown', 200, 200));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(true);

  document.dispatchEvent(pointer('pointermove', 230, 250));
  // origin (100,100) + delta (30,50) = (130,150)
  expect(moves.at(-1)).toEqual({ dx: 130, dy: 150 });

  document.dispatchEvent(pointer('pointerup', 230, 250));
  expect(document.body.classList.contains(SHIELD_CLASS)).toBe(false);

  handle.remove();
});

test('installShieldStyle injects a rule that disables iframe pointer events while dragging', () => {
  installShieldStyle(document);
  const style = document.getElementById('mithic-wm-shield-style');
  expect(style).not.toBeNull();
  expect(style!.textContent).toContain(`.${SHIELD_CLASS} iframe`);
  expect(style!.textContent).toContain('pointer-events: none');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/drag.browser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/drag.ts`**

```ts
/** Body class applied for the duration of a drag/resize gesture. */
export const SHIELD_CLASS = 'mithic-wm-dragging';
const STYLE_ID = 'mithic-wm-shield-style';

/**
 * Inject the pointer-shield stylesheet once. While `body.${SHIELD_CLASS}` is set,
 * ALL iframes ignore pointer events, so a drag gesture keeps reaching the host's
 * document-level move listeners instead of being swallowed by an iframe the
 * cursor crosses. Idempotent.
 */
export function installShieldStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `.${SHIELD_CLASS} iframe { pointer-events: none; }`;
  doc.head.appendChild(style);
}

function beginShield(doc: Document): void { doc.body.classList.add(SHIELD_CLASS); }
function endShield(doc: Document): void { doc.body.classList.remove(SHIELD_CLASS); }

export interface DragOptions {
  /** Returns the geometry origin (x,y) at gesture start. */
  onStart(): { x: number; y: number };
  /** Called on each move with the new absolute x,y. */
  onMove(x: number, y: number): void;
  onEnd?(): void;
}

/** Make `handle` start a move gesture on pointerdown. Returns a disposer. */
export function makeDraggable(handle: HTMLElement, opts: DragOptions): () => void {
  const doc = handle.ownerDocument;
  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const origin = opts.onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    beginShield(doc);
    try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    const onMove = (ev: PointerEvent): void => {
      opts.onMove(origin.x + (ev.clientX - startX), origin.y + (ev.clientY - startY));
    };
    const onUp = (): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      endShield(doc);
      opts.onEnd?.();
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', onDown);
  return () => handle.removeEventListener('pointerdown', onDown);
}

export interface ResizeOptions {
  /** Returns the size (w,h) at gesture start. */
  onStart(): { w: number; h: number };
  /** Called on each move with the new w,h (already min-clamped by the caller if needed). */
  onMove(w: number, h: number): void;
  onEnd?(): void;
  minW?: number;
  minH?: number;
}

/** Make `handle` start a resize gesture on pointerdown. Returns a disposer. */
export function makeResizable(handle: HTMLElement, opts: ResizeOptions): () => void {
  const doc = handle.ownerDocument;
  const minW = opts.minW ?? 120;
  const minH = opts.minH ?? 80;
  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const start = opts.onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    beginShield(doc);
    try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    const onMove = (ev: PointerEvent): void => {
      opts.onMove(
        Math.max(minW, start.w + (ev.clientX - startX)),
        Math.max(minH, start.h + (ev.clientY - startY)),
      );
    };
    const onUp = (): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      endShield(doc);
      opts.onEnd?.();
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', onDown);
  return () => handle.removeEventListener('pointerdown', onDown);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/drag.browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { makeDraggable, makeResizable, installShieldStyle, SHIELD_CLASS } from './drag.ts';
export type { DragOptions, ResizeOptions } from './drag.ts';
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/drag.ts packages/desktop/src/drag.browser.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): drag/resize with iframe pointer-events shield"
```

---
### Task 11: WindowManager (`window-manager.ts`)

**Files:**
- Create: `packages/desktop/src/window-manager.ts`
- Test: `packages/desktop/src/window-manager.browser.test.ts`
- Modify: `packages/desktop/src/index.ts`

> **Design:** `WindowManager` owns the desktop surface element, the window registry (Map by id), z-order (monotonic counter), the taskbar projection, and open/close. `open(app, opts)` creates a frame (Task 7), inserts it into the desktop ONCE, focuses it, then either calls `app.mount(ctx, argv)` (tier-1) or `kernel.spawn(app.entry, { display:{ mode:'window', container: win.content, ... }, capabilities })` (tier-2) and wires `kernel.wait(pid) → close`. Drag the titlebar (Task 10 `makeDraggable`) → update geometry → `applyGeometry`. Resize handle → `makeResizable`. Close button → `kernel.kill(pid,'SIGTERM')` for tier-2 or run `onClose` for tier-1, then remove the frame. Minimize/maximize toggle state. The kernel is injected; tests pass a minimal fake kernel.

- [ ] **Step 1: Write the failing browser test** — `packages/desktop/src/window-manager.browser.test.ts`:

```ts
import { expect, test, vi } from 'vitest';
import { WindowManager } from './window-manager.ts';
import { AppRegistry } from './app-registry.ts';
import type { AppDescriptor } from './types.ts';

// Minimal fake kernel: records spawn/kill and lets us resolve wait() on demand.
function fakeKernel() {
  let nextPid = 100;
  const waiters = new Map<number, (v: { code: number }) => void>();
  return {
    spawnCalls: [] as Array<{ code: unknown; init: any }>,
    killed: [] as Array<{ pid: number; sig: string }>,
    async spawn(code: unknown, init: any) {
      const pid = nextPid++;
      this.spawnCalls.push({ code, init });
      return { pid };
    },
    wait(pid: number) { return new Promise<{ code: number }>((res) => waiters.set(pid, res)); },
    kill(pid: number, sig: string) { this.killed.push({ pid, sig }); waiters.get(pid)?.({ code: 143 }); },
  };
}

function setupDesktop() {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1000px;height:700px;';
  document.body.appendChild(desktop);
  return desktop;
}

test('open() mounts a tier-1 app into a window frame in the desktop', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  const mount = vi.fn((ctx) => { ctx.content.appendChild(document.createElement('p')); });
  const editor: AppDescriptor = { name: 'editor', title: 'Editor', defaultSize: [400, 300], mount };
  apps.register(editor);
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('editor');
  expect(desktop.querySelector('[data-role="window"]')).toBe(win.frame);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(win.content.querySelector('p')).not.toBeNull();
  expect(wm.windows.length).toBe(1);

  wm.dispose();
  desktop.remove();
});

test('open() of a tier-2 app spawns a guest into the window content container', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'viewer', title: 'Viewer', defaultSize: [500, 400], entry: 'CODE;', capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }] });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const win = await wm.open('viewer');
  expect(kernel.spawnCalls.length).toBe(1);
  const call = kernel.spawnCalls[0];
  expect(call.code).toBe('CODE;');
  expect(call.init.display.mode).toBe('window');
  expect(call.init.display.container).toBe(win.content);
  expect(call.init.capabilities).toEqual([{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(win.pid).toBe(100);

  wm.dispose();
  desktop.remove();
});

test('closing a tier-2 window kills the guest with SIGTERM and removes the frame', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'viewer', title: 'V', defaultSize: [300, 200], entry: 'X;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('viewer');

  wm.close(win.id);
  expect(kernel.killed).toEqual([{ pid: win.pid, sig: 'SIGTERM' }]);
  expect(desktop.querySelector('[data-role="window"]')).toBeNull();
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('guest exit auto-closes its window', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'v', title: 'V', defaultSize: [300, 200], entry: 'X;' });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('v');
  expect(wm.windows.length).toBe(1);

  // Simulate the guest exiting: kill resolves the wait() the WM is awaiting.
  kernel.kill(win.pid!, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 0));
  expect(wm.windows.length).toBe(0);

  wm.dispose(); desktop.remove();
});

test('focus raises z-order (monotonic)', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
  apps.register({ name: 'b', title: 'B', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const a = await wm.open('a');
  const b = await wm.open('b');
  expect(b.z).toBeGreaterThan(a.z); // newest on top
  wm.focus(a.id);
  expect(a.z).toBeGreaterThan(b.z); // focusing a raises it above b

  wm.dispose(); desktop.remove();
});

test('singleton app focuses the existing window instead of opening a second', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'files', title: 'Files', defaultSize: [400, 300], singleton: true, mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });

  const first = await wm.open('files');
  const second = await wm.open('files');
  expect(second).toBe(first);
  expect(wm.windows.length).toBe(1);

  wm.dispose(); desktop.remove();
});

test('minimize hides the frame without removing it; restore shows it', async () => {
  const desktop = setupDesktop();
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'A', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, kernel: kernel as any, apps });
  const win = await wm.open('a');

  wm.minimize(win.id);
  expect(win.state).toBe('minimized');
  expect(win.frame.style.display).toBe('none');
  expect(win.frame.isConnected).toBe(true); // NOT removed — guest/content survives

  wm.restore(win.id);
  expect(win.state).toBe('normal');
  expect(win.frame.style.display).not.toBe('none');

  wm.dispose(); desktop.remove();
});

test('taskbar reflects open windows and their titles', async () => {
  const desktop = setupDesktop();
  const taskbar = document.createElement('div');
  document.body.appendChild(taskbar);
  const kernel = fakeKernel();
  const apps = new AppRegistry();
  apps.register({ name: 'a', title: 'Alpha', defaultSize: [200, 150], mount: () => {} });
  const wm = new WindowManager({ desktop, taskbar, kernel: kernel as any, apps });

  await wm.open('a');
  const items = taskbar.querySelectorAll('[data-role="taskbar-item"]');
  expect(items.length).toBe(1);
  expect(items[0].textContent).toContain('Alpha');

  wm.dispose(); desktop.remove(); taskbar.remove();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/window-manager.browser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/desktop/src/window-manager.ts`**

```ts
import type { Kernel } from '@mithic/kernel';
import type { AppDescriptor, MithicWindow, OpenOptions, WindowContext } from './types.ts';
import type { AppRegistry } from './app-registry.ts';
import { cascadePlacement, clampToBounds } from './geometry.ts';
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
  readonly #tracked = new Map<number, Tracked>();
  #nextId = 1;
  #topZ = 100;
  #openedCount = 0;

  constructor(opts: WindowManagerOptions) {
    this.#desktop = opts.desktop;
    this.#kernel = opts.kernel as WmKernel;
    this.#apps = opts.apps;
    this.#taskbar = opts.taskbar;
    installShieldStyle(opts.desktop.ownerDocument);
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

    const bounds = { w: this.#desktop.clientWidth || 1024, h: this.#desktop.clientHeight || 768 };
    const geometry = clampToBounds(cascadePlacement(this.#openedCount++, app.defaultSize, bounds), bounds);
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
    }));
    if (app.resizable !== false) {
      tracked.disposers.push(makeResizable(els.resizeHandle, {
        onStart: () => ({ w: win.geometry.w, h: win.geometry.h }),
        onMove: (w, h) => { win.geometry.w = w; win.geometry.h = h; applyGeometry(win); },
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
      // Tier-2: sandboxed iframe guest mounted INTO win.content.
      const { pid } = await this.#kernel.spawn(app.entry, {
        args: [app.name, ...(opts.argv ?? [])],
        capabilities: app.capabilities ?? [],
        display: {
          mode: 'window',
          container: win.content,
          width: win.geometry.w,
          height: win.geometry.h,
          title: app.title,
          ...opts.display,
        },
      });
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
    for (const id of [...this.#tracked.keys()]) this.close(id);
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

  #renderTaskbar(): void {
    if (!this.#taskbar) return;
    this.#taskbar.textContent = '';
    for (const t of this.#tracked.values()) {
      const item = this.#desktop.ownerDocument.createElement('button');
      item.dataset.role = 'taskbar-item';
      item.dataset.id = String(t.window.id);
      item.textContent = t.window.title;
      item.style.cssText = 'font:12px sans-serif;cursor:pointer;max-width:160px;overflow:hidden;text-overflow:ellipsis;'
        + (t.window.state === 'minimized' ? 'opacity:.6;' : '');
      item.addEventListener('click', () => {
        if (t.window.state === 'minimized') this.restore(t.window.id);
        else this.focus(t.window.id);
      });
      t.taskbarItem = item;
      this.#taskbar.appendChild(item);
    }
  }
}
```

> Note: `WmKernel` is the narrow kernel slice the WM needs (`spawn`/`wait`/`kill`); the real `Kernel` satisfies it structurally, and tests pass a fake. The `ctx.kernel` cast to `Kernel` is for the tier-1 app surface only.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run --project browser packages/desktop/src/window-manager.browser.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Append the export to `index.ts`**

```ts
export { WindowManager } from './window-manager.ts';
export type { WindowManagerOptions, WmKernel } from './window-manager.ts';
```

- [ ] **Step 6: Build the whole package + run all desktop tests**

Run: `npm run build && npx vitest run packages/desktop`
Expected: PASS (node + browser desktop suites).

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/window-manager.ts packages/desktop/src/window-manager.browser.test.ts packages/desktop/src/index.ts
git commit -m "feat(desktop): WindowManager — open/close/focus/minimize, taskbar, tier-1+tier-2"
```

---
## Wave 3 — Example desktop assembly (the runnable OS)

> Depends on Wave 2 (`@mithic/desktop` public API) + apps. Lives in `packages/examples/desktop/`. The terminal app + command suite reuse example-shell patterns; the editor/file-manager wrap the `@mithic/desktop` apps with VFS-backed adapters; the image-viewer is the tier-2 inline guest.

### Task 12: Command suite for the desktop (`commands.ts`)

**Files:**
- Create: `packages/examples/desktop/src/commands.ts`

> Reuse the example-shell in-process command suite verbatim (it solves the browser bare-import problem). Copy `packages/examples/shell/src/commands.ts` and adjust the `import.meta.glob` relative paths for the new location (`packages/examples/desktop/` is one level deeper-equal to `examples/shell`, so the `../../../coreutils/...` paths are identical — verify).

- [ ] **Step 1: Copy the command suite**

```bash
cp packages/examples/shell/src/commands.ts packages/examples/desktop/src/commands.ts
```

- [ ] **Step 2: Verify the glob paths resolve from the new location** — `examples/desktop` and `examples/shell` are siblings, so `../../../coreutils/dist/commands/*.js` etc. resolve identically. Confirm:

Run: `node -e "const p=require('path'); console.log(p.resolve('packages/examples/desktop/src','../../../coreutils/dist/commands'))"`
Expected: `.../packages/coreutils/dist/commands` (same as example-shell). No edit needed if equal.

- [ ] **Step 3: Typecheck the copied file**

Run: `npm run build -w @mithic/coreutils -w @mithic/jq -w @mithic/curl && npx tsc --noEmit -p packages/examples/desktop/tsconfig.json`
Expected: PASS (no type errors; `createCommandSuite`/`InProcessCommandLauncher` exported).

- [ ] **Step 4: Commit**

```bash
git add packages/examples/desktop/src/commands.ts
git commit -m "feat(example-desktop): in-process command suite (reused from example-shell)"
```

### Task 13: Terminal app adapter (`terminal-app.ts`)

**Files:**
- Create: `packages/examples/desktop/src/terminal-app.ts`
- Test: `packages/examples/desktop/src/terminal-app.browser.test.ts`

> **Design:** a tier-1 `mountTerminal(ctx, deps)` that builds an xterm `Terminal` into `ctx.content`, wires the existing `Executor` per-line REPL (the `bootShell` pattern), and runs commands through a `KernelClient` over the shared kernel. Reuses the same `makeKernelClient`/`makeFsClient` shapes as example-shell. Depends on the shared kernel + command suite passed in `deps` (so a single kernel/VFS backs all terminals).

- [ ] **Step 1: Write the failing browser test** — `packages/examples/desktop/src/terminal-app.browser.test.ts`:

```ts
import '@xterm/xterm/css/xterm.css';
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createCommandSuite } from './commands.ts';
import { mountTerminal } from './terminal-app.ts';

test('terminal app runs a command and writes output into the xterm DOM', async () => {
  const suite = createCommandSuite();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/hello.txt': 'hi there\n' } }));
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: (n) => suite.resolve(n), launcher: suite.launcher });

  const content = document.createElement('div');
  content.style.cssText = 'width:600px;height:360px;';
  document.body.appendChild(content);

  const term = mountTerminal(
    { window: { content } as any, content, kernel, onClose: () => {}, setTitle: () => {} },
    { kernel, vfs: vfs as any, suite },
  );

  await term.submitLine('cat /hello.txt');
  // xterm renders rows into the DOM; assert the output text is present in the buffer.
  const text = term.terminal.buffer.active;
  let dump = '';
  for (let i = 0; i < text.length; i++) dump += text.getLine(i)?.translateToString() ?? '';
  expect(dump).toContain('hi there');

  term.dispose();
  content.remove();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run --project browser packages/examples/desktop/src/terminal-app.browser.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/examples/desktop/src/terminal-app.ts`** (adapts the example-shell wiring; `makeKernelClient`/`makeFsClient` mirror example-shell — reproduce them here since example-shell does not export them):

```ts
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Executor, parse } from '@mithic/shell';
import type { KernelClient, FsClient, SpawnParams, SpawnHandle, PipelineStageParams, PipelineRunResult } from '@mithic/shell';
import type { Kernel } from '@mithic/kernel';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import type { Capability } from '@mithic/protocol';
import type { WindowContext } from '@mithic/desktop';
import type { CommandSuite } from './commands.ts';

const CHILD_CAPABILITIES: Capability[] = [
  { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  { type: 'net', origins: ['*'] },
];

export interface TerminalDeps {
  kernel: Kernel;
  vfs: FileSystemProvider;
  suite: CommandSuite;
}

export interface TerminalHandle {
  terminal: Terminal;
  submitLine(line: string): Promise<void>;
  dispose(): void;
}

/** Mount an interactive shell terminal into a window's content element. */
export function mountTerminal(ctx: WindowContext, deps: TerminalDeps): TerminalHandle {
  const { kernel, vfs, suite } = deps;
  const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(ctx.content);
  try { fit.fit(); } catch { /* zero-size in tests */ }

  // Refit on native resize (the iframe/content fills the window; resizing the
  // window frame fires resize here for free).
  const onResize = (): void => { try { fit.fit(); } catch { /* ignore */ } };
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  const context = { cwd: '/', env: { HOME: '/', PWD: '/', PATH: '/bin', SHELL: 'mithic-sh' } as Record<string, string> };
  const kernelClient = makeKernelClient(kernel);
  const fsClient = makeFsClient(vfs);

  const PROMPT = '\x1b[1;32m$\x1b[0m ';
  const prompt = (): void => terminal.write(PROMPT);
  terminal.write('mithic OS terminal\r\n');
  prompt();

  const submitLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) { prompt(); return; }
    const executor = new Executor(kernelClient, context, {
      resolve: (name) => suite.resolve(name),
      fs: fsClient,
      onStdout: (s) => terminal.write(s),
      onStderr: (s) => terminal.write(s),
    });
    try { await executor.run(parse(trimmed)); await fsClient.flush(); }
    catch (err) { terminal.write(`shell: ${(err as Error).message}\r\n`); }
    prompt();
  };

  let lineBuf = '';
  const onData = terminal.onData((data: string) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { terminal.write('\r\n'); const l = lineBuf; lineBuf = ''; void submitLine(l); }
      else if (ch === '\x7f') { if (lineBuf.length) { lineBuf = lineBuf.slice(0, -1); terminal.write('\b \b'); } }
      else { lineBuf += ch; terminal.write(ch); }
    }
  });

  ctx.setTitle('Terminal');
  ctx.onClose(() => { onData.dispose(); if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); terminal.dispose(); });

  return { terminal, submitLine, dispose() { onData.dispose(); terminal.dispose(); } };
}

function makeKernelClient(kernel: Kernel): KernelClient {
  const enc = new TextEncoder();
  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      const { pid, stdout } = await kernel.spawn(params.code, {
        args: params.args, env: params.env, cwd: params.cwd, capabilities: CHILD_CAPABILITIES,
        captureStdout: params.captureStdout, captureStderr: params.captureStderr,
        stdinData: params.stdinData !== undefined ? enc.encode(params.stdinData) : undefined,
      });
      return { pid, stdout };
    },
    async wait(pid: number) { const { code } = await kernel.wait(pid); return { pid, code }; },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const result = await kernel.runPipeline(stages.map((s, i) => ({
        code: s.code, args: s.args, env: s.env, cwd: s.cwd, capabilities: CHILD_CAPABILITIES,
        captureStdout: i === stages.length - 1 ? s.captureStdout : false, captureStderr: s.captureStderr,
        stdinData: i === 0 && s.stdinData !== undefined ? enc.encode(s.stdinData) : undefined,
      })));
      return { pids: result.pids, exitCodes: result.exitCodes, lastStdout: result.lastStdout, stderr: result.stderr };
    },
  };
}

function makeFsClient(fs: FileSystemProvider): FsClient & { flush(): Promise<void> } {
  const enc = new TextEncoder(); const dec = new TextDecoder();
  interface Open { path: string; data: string; write: boolean; append: boolean }
  const open = new Map<number, Open>(); let nextFd = 1000; const pending: Array<Promise<unknown>> = [];
  const readFile = async (path: string): Promise<string> => {
    const h = (await fs.open(path, { read: true })) as FileHandle; const chunks: Uint8Array[] = []; let off = 0;
    for (;;) { const c = await fs.read(h, off, 65536); if (!c || c.byteLength === 0) break; chunks.push(new Uint8Array(c)); off += c.byteLength; }
    await fs.close(h); let t = 0; for (const c of chunks) t += c.byteLength; const buf = new Uint8Array(t); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; } return dec.decode(buf);
  };
  return {
    async flush() { await Promise.all(pending); },
    fsOpen(path, flags): number { const fd = nextFd++; open.set(fd, { path, data: '', write: !!flags.write, append: !!flags.append }); return fd; },
    fsWrite(fd, data): void { const o = open.get(fd); if (o) o.data += data; },
    async fsRead(fd): Promise<string> { const o = open.get(fd); if (!o) return ''; return readFile(o.path); },
    fsClose(fd): void { const o = open.get(fd); open.delete(fd); if (o && (o.write || o.append)) { pending.push((async () => { const h = (await fs.open(o.path, { write: !o.append, append: o.append, create: true, truncate: !o.append })) as FileHandle; await fs.write(h, enc.encode(o.data), 0); await fs.close(h); })()); } },
    async fsReaddir(path): Promise<string[]> { const e = await fs.readdir(path); return e.map((x) => x.name); },
    async fsStat(path): Promise<{ dir: boolean } | undefined> { try { const s = await fs.stat(path); return { dir: s.type === 'directory' }; } catch { return undefined; } },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run --project browser packages/examples/desktop/src/terminal-app.browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/examples/desktop/src/terminal-app.ts packages/examples/desktop/src/terminal-app.browser.test.ts
git commit -m "feat(example-desktop): tier-1 xterm terminal app (reuses shell Executor)"
```

### Task 14: Desktop boot — wire kernel, VFS, apps, WM (`boot.ts`)

**Files:**
- Create: `packages/examples/desktop/src/boot.ts`
- Create: `packages/examples/desktop/src/image-viewer-guest.ts` (the inline tier-2 guest source string)

> **Design:** `bootDesktop({ desktop, taskbar, launcher })` builds ONE shared Kernel (IframeRuntime mounting into `desktop` as the fallback container) + VFS (Memory at `/`, Device at `/dev`; OPFS at `/` is wired in Task 15's page entry guarded by availability), registers four apps, mounts a `WindowManager`, and renders a launcher (buttons in the taskbar). Returns `{ wm, kernel, vfs }`. The editor/file-manager apps are adapted with VFS-backed `EditorFs`/`FileManagerFs`; the image-viewer is the inline guest.

- [ ] **Step 1: Create `packages/examples/desktop/src/image-viewer-guest.ts`** (self-contained inline guest; same technique the removed notebook used — reproduced here so removal is clean):

```ts
/* eslint-disable @stylistic/indent -- embedded guest JS string */
/** Inline image-viewer guest (opaque-origin iframe cannot import @mithic/*). */
export const IMAGE_VIEWER_GUEST = /* js */`
function portToWritable(port) {
  port.start?.();
  let credit = 0; const waiters = [];
  port.onmessage = (e) => { const m = e.data; if (m && m.type === 'credit') { credit += m.bytes; while (waiters.length && credit >= waiters[0].needed) waiters.shift().resolve(); } };
  async function send(chunk) { if (credit < chunk.byteLength) await new Promise(r => waiters.push({ needed: chunk.byteLength, resolve: r })); credit -= chunk.byteLength; port.postMessage({ type: 'data', chunk }); }
  return new WritableStream({ write(c) { return send(c); }, close() { port.postMessage({ type: 'end' }); port.close(); }, abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); } });
}
function createGuest({ control, init, preopenPorts = {} }) {
  const signalListeners = [];
  control.start?.();
  control.onmessage = (e) => { const m = e.data; if (m && typeof m === 'object' && m.event === 'signal') { const p = m.payload || {}; for (const cb of signalListeners) cb(p.signal || '', p.extra); } };
  const stdoutPort = preopenPorts[1];
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream();
  return { pid: init.pid, args: init.args, env: init.env, cwd: init.cwd, stdout, onSignal(cb) { signalListeners.push(cb); }, exit(code) { control.postMessage({ type: 'exit', code }); control.close(); } };
}
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  const enc = new TextEncoder();
  const dz = document.createElement('div');
  dz.id = 'drop-zone'; dz.textContent = 'Drop an image here';
  dz.style.cssText = 'border:2px dashed #888;border-radius:8px;padding:24px;text-align:center;font:14px sans-serif;color:#ccc;margin:12px;';
  const img = document.createElement('img'); img.id = 'preview'; img.style.maxWidth = '100%'; img.style.display = 'none';
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('drop', (e) => { e.preventDefault(); const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (file) { const url = URL.createObjectURL(file); img.src = url; img.style.display = 'block'; dz.textContent = file.name; w.write(enc.encode('img-rendered:' + url + '\\n')); } });
  document.body.style.cssText = 'margin:0;background:#1e1e2e;color:#ccc;';
  document.body.appendChild(dz); document.body.appendChild(img);
  await w.write(enc.encode('ready\\n'));
  await new Promise((resolve) => g.onSignal(() => resolve()));
  await w.close().catch(() => {});
  g.exit(0);
};
`;
/* eslint-enable @stylistic/indent */
```

- [ ] **Step 2: Create `packages/examples/desktop/src/boot.ts`**

```ts
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle } from '@mithic/io/vfs';
import { WindowManager, AppRegistry, mountTextEditor, mountFileManager } from '@mithic/desktop';
import type { EditorFs, FileManagerFs, Entry, WindowContext } from '@mithic/desktop';
import { createCommandSuite } from './commands.ts';
import { mountTerminal } from './terminal-app.ts';
import { IMAGE_VIEWER_GUEST } from './image-viewer-guest.ts';

const SEED: Record<string, string> = {
  '/welcome.txt': 'Welcome to Mithic OS!\nEverything here runs sandboxed in your browser.\n',
  '/notes.txt': 'edit me\n',
  '/tmp/.keep': '',
};

export interface DesktopHandle {
  wm: WindowManager;
  kernel: Kernel;
  vfs: FileSystemProvider;
}

/** Build VFS-backed adapters for the editor + file-manager apps. */
function editorFs(vfs: FileSystemProvider): EditorFs {
  const dec = new TextDecoder(); const enc = new TextEncoder();
  return {
    async readFile(path) {
      const h = (await vfs.open(path, { read: true })) as FileHandle;
      const chunks: Uint8Array[] = []; let off = 0;
      for (;;) { const c = await vfs.read(h, off, 65536); if (!c || c.byteLength === 0) break; chunks.push(new Uint8Array(c)); off += c.byteLength; }
      await vfs.close(h); let t = 0; for (const c of chunks) t += c.byteLength; const b = new Uint8Array(t); let o = 0; for (const c of chunks) { b.set(c, o); o += c.byteLength; } return dec.decode(b);
    },
    async writeFile(path, text) {
      const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle;
      await vfs.write(h, enc.encode(text), 0); await vfs.close(h);
    },
  };
}

function fileManagerFs(vfs: FileSystemProvider): FileManagerFs {
  return {
    async list(path) {
      const entries = await vfs.readdir(path);
      return entries.map((e): Entry => ({ name: e.name, kind: e.type === 'directory' ? 'directory' : 'file' }));
    },
    async mkdir(path) { await vfs.mkdir(path); },
    async createFile(path) { const h = (await vfs.open(path, { write: true, create: true, truncate: true })) as FileHandle; await vfs.close(h); },
    async remove(path) { try { await vfs.unlink(path); } catch { await vfs.rmdir(path); } },
    async rename(from, to) { await vfs.rename(from, to); },
  };
}

export interface BootOptions {
  desktop: HTMLElement;
  taskbar?: HTMLElement;
  /** Extra VFS to use instead of the default seeded MemoryFs (e.g. OPFS at /). */
  vfs?: FileSystemProvider;
}

export async function bootDesktop(opts: BootOptions): Promise<DesktopHandle> {
  const suite = createCommandSuite();

  let vfs: FileSystemProvider;
  if (opts.vfs) {
    vfs = opts.vfs;
  } else {
    const router = new FileSystemRouter();
    await router.mount('/', new MemoryFsProvider({ files: SEED }));
    await router.mount('/dev', new DeviceFsProvider());
    vfs = router;
  }

  const kernel = new Kernel({
    runtime: new IframeRuntime({ container: opts.desktop }),
    vfs,
    resolveCommand: (name) => suite.resolve(name),
    launcher: suite.launcher,
  });

  const apps = new AppRegistry();
  const efs = editorFs(vfs);
  const ffs = fileManagerFs(vfs);

  const wm = new WindowManager({ desktop: opts.desktop, taskbar: opts.taskbar, kernel, apps });

  apps.register({ name: 'terminal', title: 'Terminal', defaultSize: [640, 400], icon: '🖥️',
    mount: (ctx: WindowContext) => { mountTerminal(ctx, { kernel, vfs, suite }); } });

  apps.register({ name: 'editor', title: 'Editor', defaultSize: [600, 420], icon: '📝',
    mount: (ctx: WindowContext, argv) => { mountTextEditor(ctx, argv.length ? argv : ['/notes.txt'], efs); } });

  apps.register({ name: 'files', title: 'Files', defaultSize: [560, 420], icon: '📁', singleton: true,
    mount: (ctx: WindowContext) => {
      mountFileManager(ctx, { fs: ffs, onOpen: (path) => {
        const app = apps.resolveForFile(path) ?? apps.get('editor')!;
        void wm.open(app.name, { argv: [path] });
      } });
    } });

  apps.register({ name: 'image-viewer', title: 'Image Viewer', defaultSize: [480, 360], icon: '🖼️',
    entry: IMAGE_VIEWER_GUEST, capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }] });

  apps.associate('txt', 'editor');
  apps.associate('json', 'editor');
  apps.associate('md', 'editor');
  apps.associate('png', 'image-viewer');
  apps.associate('jpg', 'image-viewer');
  apps.associate('jpeg', 'image-viewer');
  apps.associate('gif', 'image-viewer');

  return { wm, kernel, vfs };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build && npx tsc --noEmit -p packages/examples/desktop/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/examples/desktop/src/boot.ts packages/examples/desktop/src/image-viewer-guest.ts
git commit -m "feat(example-desktop): bootDesktop — shared kernel/VFS + 4 registered apps"
```

### Task 15: Page entry + launcher (`main.ts`)

**Files:**
- Modify: `packages/examples/desktop/src/main.ts`

> **Design:** the page entry mounts the desktop, tries OPFS-at-`/` (falling back to MemoryFs), and renders a simple launcher (buttons in the taskbar that `wm.open(name)`).

- [ ] **Step 1: Replace the stub `packages/examples/desktop/src/main.ts`**

```ts
import { bootDesktop } from './boot.ts';
import { FileSystemRouter, DeviceFsProvider } from '@mithic/io/vfs';
import type { FileSystemProvider } from '@mithic/io/vfs';

/** Try OPFS at `/` (persistent); fall back to the default seeded MemoryFs. */
async function persistentVfs(): Promise<FileSystemProvider | undefined> {
  try {
    if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return undefined;
    const { OPFSProvider } = await import('@mithic/io/vfs/providers/opfs');
    const router = new FileSystemRouter();
    const opfs = new OPFSProvider();
    await router.mount('/', opfs);
    await router.mount('/dev', new DeviceFsProvider());
    return router;
  } catch { return undefined; }
}

async function main(): Promise<void> {
  const desktop = document.getElementById('desktop');
  const taskbar = document.getElementById('taskbar');
  if (!desktop || !taskbar) return;

  const vfs = await persistentVfs();
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  // Launcher: a button per app, prepended into the taskbar (before window items).
  const launcher = document.createElement('div');
  launcher.style.cssText = 'display:flex;gap:4px;margin-right:8px;border-right:1px solid #313244;padding-right:8px;';
  for (const name of ['terminal', 'files', 'editor', 'image-viewer']) {
    const b = document.createElement('button');
    b.textContent = name;
    b.style.cssText = 'font:12px sans-serif;cursor:pointer;';
    b.addEventListener('click', () => { void wm.open(name); });
    launcher.appendChild(b);
  }
  taskbar.prepend(launcher);

  // Open a terminal by default.
  void wm.open('terminal');
}

if (typeof document !== 'undefined' && document.getElementById('desktop')) {
  void main();
}

export { main };
```

- [ ] **Step 2: Dev-server smoke check (manual, optional)**

Run: `npm run dev -w @mithic/example-desktop` then open the printed URL.
Expected: a desktop with a terminal window + launcher buttons; clicking `files`/`editor`/`image-viewer` opens draggable windows.

- [ ] **Step 3: Build**

Run: `npm run build -w @mithic/example-desktop`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/examples/desktop/src/main.ts
git commit -m "feat(example-desktop): page entry + launcher + OPFS-at-/ with MemoryFs fallback"
```

### Task 16: End-to-end desktop browser test (`boot.browser.test.ts`)

**Files:**
- Create: `packages/examples/desktop/src/boot.browser.test.ts`

- [ ] **Step 1: Write the E2E browser test**

```ts
import { expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { bootDesktop } from './boot.ts';

function surface() {
  const desktop = document.createElement('div');
  desktop.style.cssText = 'position:relative;width:1024px;height:700px;';
  const taskbar = document.createElement('div');
  document.body.append(desktop, taskbar);
  return { desktop, taskbar };
}

test('opens a terminal window and a tier-1 editor window', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/notes.txt': 'hi\n' } }));
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  await wm.open('terminal');
  await wm.open('editor', { argv: ['/notes.txt'] });

  const frames = desktop.querySelectorAll('[data-role="window"]');
  expect(frames.length).toBe(2);
  // Editor textarea is present and loaded.
  const ta = desktop.querySelector('textarea') as HTMLTextAreaElement;
  expect(ta).not.toBeNull();
  // Allow the editor's async load to settle.
  await new Promise((r) => setTimeout(r, 20));
  expect(ta.value).toBe('hi\n');

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('opens the image-viewer as a sandboxed (tier-2) window and reports ready', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  // A sandboxed iframe is mounted INSIDE the window content (not document.body).
  const iframe = win.content.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  expect(win.pid).toBeGreaterThan(0);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('file manager "Open With" launches the associated editor window', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/a.txt': 'content\n' } }));
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  await wm.open('files');
  await new Promise((r) => setTimeout(r, 20)); // listing load
  const fileRow = desktop.querySelector('[data-name="a.txt"]') as HTMLElement;
  expect(fileRow).not.toBeNull();
  fileRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  // A second window (the editor) opened for the file.
  const frames = desktop.querySelectorAll('[data-role="window"]');
  expect(frames.length).toBe(2);
  const editorTitle = [...desktop.querySelectorAll('[data-role="title"]')].some((t) => t.textContent?.includes('a.txt'));
  expect(editorTitle).toBe(true);

  wm.dispose(); desktop.remove(); taskbar.remove();
});

test('closing a tier-2 window removes its frame', async () => {
  const { desktop, taskbar } = surface();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const { wm } = await bootDesktop({ desktop, taskbar, vfs });

  const win = await wm.open('image-viewer');
  expect(desktop.querySelectorAll('[data-role="window"]').length).toBe(1);
  wm.close(win.id);
  expect(desktop.querySelectorAll('[data-role="window"]').length).toBe(0);

  wm.dispose(); desktop.remove(); taskbar.remove();
});
```

- [ ] **Step 2: Run the E2E browser test**

Run: `npm run build && npx vitest run --project browser packages/examples/desktop/src/boot.browser.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 3: Commit**

```bash
git add packages/examples/desktop/src/boot.browser.test.ts
git commit -m "test(example-desktop): E2E — open terminal/editor/files/image-viewer windows"
```

---

## Integration & final gate

### Task 17: Full monorepo gate

- [ ] **Step 1: Run the full gate from the monorepo root**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS — all node + browser projects green; no notebook references; new desktop suites included.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore: browser-os integration gate green" || echo "nothing to commit"
```

---

## Comprehensive review (dedicated subagent)

After Task 17 is green, dispatch a review subagent (see the orchestration note) to audit: correctness, edge cases, test coverage (happy/edge/error per AGENTS.md), and SE principles (SOLID/DRY/KISS/SoC). Specifically verify:
- The minimize-no-reload invariant has a test proving the iframe/guest survives `display:none` (Task 11 covers `isConnected` + frame retention; confirm a tier-2 guest's pid survives minimize→restore — add a test if missing).
- The drag-across-iframe pointer-shield has a regression test (Task 10 covers the shield toggle; confirm an integration test drags a window over a second window's iframe and geometry still tracks — add to Task 16 if missing).
- No iframe is ever reparented anywhere in `window-manager.ts` (grep for `appendChild`/`insertBefore` on a frame/content that already has a parent).
- Capability narrowing: tier-2 apps receive only their declared `capabilities`.
- `@mithic/desktop` has NO third-party runtime dependency and NO xterm/editor import.

---

## Self-review checklist (author, pre-handoff)

- [ ] Spec coverage: WM (Tasks 7,10,11), terminal (13), editor (8), file manager (9), image-viewer (14/16), example assembly (12–16), notebook removal (3), OPFS-at-/ (15), runtime container (1). ✓
- [ ] No placeholders: every code step has complete code. ✓
- [ ] Type consistency: `MithicWindow`/`WindowContext`/`AppDescriptor` (Task 2) used identically in 7/11/13/14; `EditorFs`/`FileManagerFs` defined in 8/9 and adapted in 14; `WmKernel` slice matches the fake kernels in 11/16. ✓
