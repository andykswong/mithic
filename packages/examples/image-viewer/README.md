# @mithic/example-image-viewer

A **GUI Mithic process** for Mithic 2.0: a tiny image viewer that renders a
drag-and-drop zone plus a preview `<img>` **inside its own sandboxed iframe DOM**.

This is an **iframe process**. The kernel launches it through the GUI-capable
`IframeRuntime` (`@mithic/runtime/backends/iframe`), so the guest runs inside a
real `sandbox="allow-scripts"`, opaque-origin browser document and draws
**directly into its own DOM** — no Remote DOM mirroring. The guest is a normal
`@mithic/guest-runtime` process: `createGuest(boot)` gives it stdio + signals,
and `main()` mounts the UI, then stays alive until the kernel signals it.

```
Kernel.spawn(code, { display: 'inline'|'window' })
        │
        ▼
   IframeRuntime  ──mounts──▶  sandboxed iframe (opaque origin)
                                   │  guest draws into document.body:
                                   │    • #drop-zone  (drag/drop target)
                                   │    • #preview    (<img>)
                                   └─ stdout markers ──▶ host / test
```

## What it does

- `renderImageViewer(doc, onRendered)` (exported, pure DOM, no I/O) builds the
  `#drop-zone` and `#preview` `<img>`, wires `dragover`/`drop`, and on a dropped
  file creates an object URL, sets `<img>.src`, and invokes `onRendered(url)`.
  It returns a handle (`{ img, loadFile }`) so a caller or in-iframe test can
  drive a synthetic drop programmatically.
- The default-exported `main(boot)` runs it as a guest: it mounts the viewer,
  then waits for `SIGTERM`/`SIGKILL` so the kernel can reap it cleanly.

### Self-reporting protocol

Because the iframe is opaque-origin, the host page cannot read the guest's DOM
cross-origin. The guest therefore reports its lifecycle as newline-delimited
markers on **stdout**, which the host or test asserts on:

- `ready` — the drop zone and `<img>` are mounted.
- `img-rendered:<url>` — a file was dropped; `<img>.src` is now `<url>` (an
  object URL).

> Sandbox CSP note: the iframe `srcdoc` ships `default-src 'none'`, which blocks
> `blob:`/`object:` image fetches, so a dropped image does not visually decode
> *inside* the sandbox. The DOM work — creating the `<img>`, wiring the drop
> handler, and setting `.src` — is nonetheless real, and is what this example
> demonstrates and self-reports.

## Manifest

`manifest.json` declares how the kernel should launch this process:

```jsonc
{
  "name": "image-viewer",
  "entry": "./dist/process.js",
  "display": { "mode": "window", "defaultSize": [800, 600] },
  "capabilities": { "fs": { "paths": ["/tmp"], "operations": ["read", "write"] } }
}
```

- `display.mode: "window"` — a GUI process with a default `800×600` surface.
- `capabilities.fs` — the only capability it requests is read/write on `/tmp`.

The package also exports the manifest via the `./manifest` subpath.

## Exports

```ts
import main, { renderImageViewer } from '@mithic/example-image-viewer';
import manifest from '@mithic/example-image-viewer/manifest';
```

- `default` (`main`) — the guest entry the kernel boots.
- `renderImageViewer(doc, onRendered)` — the DOM-only render helper.

## Build & test

```sh
npm run build      # vite build into dist/ (dist/process.js is the guest entry)
npm test           # the Chromium browser test (vitest run)
npm run typecheck
npm run lint
```

The browser test (`src/process.browser.test.ts`) spawns the viewer via
`Kernel` + `IframeRuntime` in `display: 'inline'`, has the guest self-drive a
synthetic PNG drop, and asserts on the `ready` / `img-rendered:` stdout markers
and that a visible iframe was mounted.

It is also rendered live inside `@mithic/example-notebook`, where the
`open-image` command spawns it inline into the notebook's results pane.
