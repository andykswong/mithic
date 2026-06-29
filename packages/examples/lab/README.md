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

This is about the **module form of a guest's bytes**, not how the file gets into the VFS
(`echo … > /usr/bin/foo` works — exec-from-VFS reads and runs those bytes). When the
kernel execs a `#!/bin/node` file, the WorkerRuntime bootstrap runs the (shebang-stripped)
source via `(0,eval)(source)` and reads `globalThis.__mithic_default`. So the bytes must be
a **self-contained classic-script IIFE**: a top-level `export default` is a `SyntaxError`
under `eval`, and a bare `import '@mithic/guest-runtime'` can't resolve in an opaque-origin
worker. A normal hand-authored ESM guest therefore won't run from VFS bytes in-browser
today — so a build-time `?bundle` esbuild plugin (`src/bundle-plugin.ts`) emits the IIFE
form for each utility, which `installUtility` writes to `/usr/bin/<name>`. Letting an
*unbundled* ESM guest run from VFS in-sandbox needs a per-backend resolver (a worker
import-map / `blob:` module bootstrap) — deferred Phase-1.2 work (RFC 0001 §4.2
"As-built"). On Node the launcher loads a real ESM graph, so it has no such constraint.
