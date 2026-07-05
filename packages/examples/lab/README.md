# @mithic/example-lab

The in-browser **file-automation Lab** for Mithic 2.0 — the Phase-1 product loop
(RFC 0001, *The File-Automation Engine*): *drop a file → compose a workflow of ≥2
utilities → process entirely in-browser (no upload) → preview + download → save the
workflow → re-run deterministically.*

It demonstrates the **Unix-honest** execution model on top of `@mithic/kernel`: a workflow
**is a shell script**, a utility **is an executable file in the VFS**, and a utility's
authority lives in its `security.capability` **file extended-attribute** (set at install
from an `AppManifest`, read at exec, narrowed against the parent). No bespoke workflow
format, no command registry — just `$PATH` lookup + shebang dispatch.

```
host page (trusted)                       kernel + shell + guests (sandboxed)
─────────────────                         ───────────────────────────────────
ingestFile(File) ─▶ /in/photo.png ──┐
                                     │  run  resize-and-convert  (a #!/bin/bash script)
                                     ▼     imgresize /in/photo.png /work/a.webp   (#!/bin/node guest)
   preview ◀── RemoteDomHost(blob:) ◀─     imgconvert /work/a.webp /out/photo.jpeg
   download ◀── readVfsToBlob ◀────────  /out/photo.jpeg            (each: $PATH→/usr/bin/<name>,
                                                                     execute-bit + security.capability
                                                                     xattr → narrowed caps, run from VFS)
```

## What it shows

- **Install = capability grant.** At boot, `createLab` installs each utility into
  `/usr/bin` via `installUtility` (`src/install.ts`): it writes the bytes, sets the
  execute bit, and writes the `AppManifest`'s capabilities into the file's
  `security.capability` xattr. Running a utility by bare name execs it from the VFS, and
  the kernel narrows it to exactly its declared grant — an undeclared `net` or an
  out-of-grant write is denied even when the parent shell holds it.
- **Workflow = shell script.** A `#!/bin/bash` file chains utilities by **path arguments**
  (`imgresize "$1" /work/a.webp; imgconvert /work/a.webp "$2"`), so binary never traverses
  the string-typed shell. The script is the durable, re-runnable artifact.
- **Web-API utilities.** `copy`, `csvcols`, and the `OffscreenCanvas`-based `imgresize` /
  `imgconvert` (from `@mithic/coreutils`) read/write VFS paths via the standard
  `await guest.fs.getDirectory()` File System Access surface — no Node APIs, no WASM.
- **Binary in/out from the host page.** `ingestFile` streams a local `File` into the VFS;
  `readVfsToBlob` / `triggerDownload` stream a result back out — both byte-faithful at MB
  scale, never materializing the whole file (`src/ingest.ts`, `src/download.ts`).
- **Preview that paints.** A per-window `RemoteDomHost` (wired via
  `KernelOptions.onDomMutate`, demuxed by pid) renders a result as a host-created `blob:`
  `<img>`/`<video>` (`src/preview.ts`).
- **Persistence.** The OPFS-backed mount keeps the workflow scripts and the installed
  utilities (with their xattr capabilities) across reload, so a saved workflow re-runs
  deterministically.

## The image-tool page (single-utility demand-validation surface)

`index.html` boots **the image-tool product page** (`src/image-tool/`): a privacy-first
"resize & convert an image" tool. The UI runs as a **GUI guest** in a visible sandboxed
iframe (`IframeRuntime`) that owns its drop zone, writes the dropped bytes to the VFS via
the `fs` syscall, runs the `#!/bin/bash` `resize-convert` workflow (chaining `imgresize`
→ `imgconvert` — composition via exec-from-VFS), reads the result back, mints a `blob:`
inside its own iframe and paints it under the shipped G6 CSP (`img-src blob:`), and offers
download + a "run at scale / self-host" CTA. Image bytes never leave the device; the only
egress is a content-free, first-party telemetry beacon (`src/image-tool/telemetry.ts`),
configurable via `VITE_TELEMETRY_ENDPOINT` (defaults to a console-only sink). No COOP/COEP,
no OPFS, no third-party analytics — single file per run.

## API

```ts
import { createLab } from '@mithic/example-lab';

const lab = await createLab();          // kernel + WorkerRuntime + VFS + shell + /usr/bin
const out = await lab.run('echo hi');   // headless shell: returns captured stdout
// lab.kernel / lab.vfs are exposed for the ingest/download/preview helpers.
```

`createLab(options)` accepts `persistStorage` (an `OPFSStorageManager`, or `null` to skip
OPFS — used by the persistence test to simulate a reload over the same root) and an
`onPreview` hook for the Remote-DOM preview pane.

## Run it

```sh
npm run dev        # vite dev server — open the printed URL
npm run build      # production build into dist/
npm run start      # preview the production build
npm test           # the Chromium browser tests (vitest --project browser)
```

## How utilities load in the browser

This is about the **module form of a guest's bytes**, not how the file gets into the VFS
(`echo … > /usr/bin/foo` works — exec-from-VFS reads and runs those bytes). When the
kernel execs a `#!/bin/node` file, the Worker/iframe bootstrap mints an **in-sandbox
`blob:` module** from the (shebang-stripped) source and `await import()`s it — it is no
longer `(0,eval)`-d. A hand-authored **ESM** guest (top-level `export default (boot) => …`)
therefore **runs directly from VFS bytes in-browser** (OF1), and it resolves `@mithic/*`
deps by importing a URL it reads from a host-curated `boot.imports` map of in-sandbox
`blob:` module URLs — **not** a bare specifier, **not** a browser import map, and with **no
source rewrite** (G2). This is shipped; see the design spec
`2026-07-04-esm-guest-loading-and-iframe-csp.md`.

The build-time `?bundle` esbuild plugin (`build/bundle-plugin.ts`) is **still supported** and
is the **fallback for dep-heavy guests**: it emits a self-contained classic-script IIFE whose
footer sets `globalThis.__mithic_default`, which the stage-2 loader picks up (esbuild drops
`export default`, so an IIFE guest has no `mod.default` — the loader resolves the entrypoint
as `mod.default ?? globalThis.__mithic_default`, covering both forms). `installUtility` writes
either form to `/usr/bin/<name>`. On Node the launcher loads a real ESM graph and populates
`boot.imports` with `file://` URLs, so the same guest runs isomorphically.
