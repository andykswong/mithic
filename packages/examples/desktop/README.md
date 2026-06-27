# @mithic/example-desktop

> A minimalist **browser OS** for Mithic 2.0 — a window manager plus four apps (terminal, text editor, file manager, image viewer) over one shared capability-gated kernel and VFS.

This example boots a single `Kernel` (GUI-capable `IframeRuntime`) + a `FileSystemRouter` VFS, registers four apps with `@mithic/desktop`'s `AppRegistry`, and mounts a `WindowManager` into the page. It is the runnable demonstration of the design in [`docs/isola/005-browser-os-design.md`](../../../../../docs/isola/005-browser-os-design.md).

```
┌─ desktop (window frames mount here, never reparented) ─────────────┐
│  ┌─ Terminal ─┐  ┌─ Editor ─┐   ┌─ Files ─┐   ┌─ Image Viewer ─┐    │
│  │ xterm.js   │  │<textarea>│   │ tree+   │   │ sandboxed       │    │
│  │ + shell    │  │          │   │ list    │   │ iframe (tier-2) │    │
│  └────────────┘  └──────────┘   └─────────┘   └─────────────────┘    │
├────────────────────────────────────────────────────────────────────┤
│  taskbar: [launcher: terminal files editor image-viewer] [windows…] │
└────────────────────────────────────────────────────────────────────┘
        one shared Kernel + VFS backs every window
```

## The apps

| App | Tier | Notes |
|-----|------|-------|
| **Terminal** | tier-1 (host DOM) | xterm.js + `@mithic/shell` `Executor` + the full coreutils/jq/curl command suite. Line editor with command **history** (↑/↓) and **Ctrl+C**, fit-to-window, clickable links. |
| **Text editor** | tier-1 | A plain `<textarea>` (no editor library): open from a path, Ctrl+S save, dirty marker, Tab-inserts-tab, read-only mode. |
| **File manager** | tier-1 | Two-pane tree + list over the VFS: clickable breadcrumb, back/forward, selection, a real context menu (Open / Open With / New / Rename / Delete), drag-to-move, and **Open-With** (extension → app). |
| **Image viewer** | **tier-2 (sandboxed)** | The reference untrusted app: a self-contained inline guest spawned into its window's iframe with only `fs:/tmp` capability. Proves the sandboxed-app path end-to-end. |

## How it works

- **One shared kernel + VFS.** `bootDesktop({ desktop, taskbar, vfs })` builds the `Kernel` (with `IframeRuntime` mounting tier-2 iframes into per-window containers), composes the command suite, and registers the apps.
- **In-process command suite.** `commands.ts` reuses the `@mithic/example-shell` trick: command guest modules are bundled by Vite (`import.meta.glob`) and run in-process via a custom launcher keyed by a `command:<name>` sentinel — because an opaque-origin iframe cannot resolve bare `@mithic/*` imports.
- **Open-With glue.** The file manager's `onOpen(path)` resolves the associated app via `AppRegistry.resolveForFile` (falling back to the editor) and calls `wm.open(app, { argv: [path] })`.
- **Persistence.** `main.ts` mounts a real `OPFSProvider` at `/` when available (falling back to a seeded in-memory FS), so files and per-app window geometry survive a reload.

## Run it

```sh
npm run dev --workspace=@mithic/example-desktop
```

Opens the desktop with a terminal window and a launcher. Click `files` / `editor` / `image-viewer` to open draggable, resizable windows; drag titlebars, resize from the corner, minimize/maximize, and close (which `SIGTERM`s a sandboxed guest).

## Build & test

```sh
npm run build
npm test           # Chromium (Playwright) browser tests
npm run typecheck
npm run lint
```

`boot.browser.test.ts` is the E2E: it opens the terminal + editor windows, opens the sandboxed image-viewer (asserting its iframe is `sandbox="allow-scripts"` inside the window content), drives the file manager's Open-With, and verifies close removes the frame. `terminal-app.browser.test.ts` covers the terminal's command run, history, and Ctrl+C.

## License

MIT
