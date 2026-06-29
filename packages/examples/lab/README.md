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

The WorkerRuntime bootstrap `eval`s a guest's source as a **classic script** and reads
`globalThis.__mithic_default`. A raw dist-ESM module (with a bare `@mithic/guest-runtime`
import and `export default`) cannot run that way, so a build-time `?bundle` esbuild plugin
(`src/bundle-plugin.ts`) emits a **self-contained classic-IIFE** for each utility; that is
what `installUtility` writes into `/usr/bin/<name>` with a `#!/bin/node` shebang. So
in-browser today, "drop a file into `/usr/bin`" means *drop a bundled IIFE* — a
per-backend sandbox-side module resolver (import-map / Worker module bootstrap) is the
deferred Phase-1.2 work that would let an unbundled guest run in-sandbox (RFC 0001
§4.2 "As-built"). On Node the launcher loads a real ESM graph and has no such constraint.
