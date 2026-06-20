# @mithic/example-notebook

The **capstone integration** for Mithic 2.0: an [xterm.js](https://xtermjs.org/)
**shell notebook** in the browser that boots an `@mithic/kernel` `Kernel` over a
GUI-capable `IframeRuntime`, runs the `@mithic/shell` interpreter wired to the
terminal, executes the full `@mithic/coreutils` + `@mithic/jq` + `@mithic/curl`
command suite as real sandboxed guest processes, **and** renders GUI processes
(the image-viewer) inline as iframes in a results pane.

```
┌─ #terminal (xterm.js) ─────────────┐   ┌─ #results pane ────────────┐
│ keystrokes → line buffer           │   │ GUI processes mount here:   │
│   Enter → @mithic/shell Executor    │   │   IframeRuntime iframe(s)   │
│            │                        │   │   e.g. open-image           │
│   builtins (in-process)             │   └─────────────────────────────┘
│   externals → KernelClient ─────────┼────▶ Kernel.spawn / runPipeline
│   redirects/glob → FsClient ────────┼────▶ seeded MemoryFs (VFS)
└─────────────────────────────────────┘
```

## What it does

- **xterm ↔ shell ↔ kernel.** Keystrokes from xterm's `onData` accumulate into a
  line buffer; Enter submits the line to a shell `Executor` whose
  `onStdout`/`onStderr` sinks write straight back into the terminal.
- **Builtins in-process, externals forked.** The executor runs shell builtins
  in-process and forks external commands through a real `KernelClient` backed by
  `kernel.spawn` / `kernel.runPipeline`. So `ls`, `cat`, `echo hi | grep h`,
  `sort | uniq`, `seq | awk`, and `jq` run the REAL command guests end-to-end.
- **Redirects & glob over a seeded VFS.** Redirects (`>`, `>>`, `<`) and pathname
  expansion go through an `FsClient` over a seeded in-memory VFS (`MemoryFs`
  mounted at `/`), so `echo hi > /tmp/x; cat /tmp/x` and `cat *.txt` work. Seed
  files: `/welcome.txt`, `/fruits.txt`, `/data.json`, `/numbers.txt`, `/tmp`.
- **Inline GUI processes — the distinctive feature.** A notebook-level
  `open-image` command spawns the image-viewer GUI process via
  `kernel.spawn(code, { display: { mode: 'inline', … } })`; the GUI-capable
  `IframeRuntime` mounts the resulting iframe into the `#results` pane.

Try:

```sh
ls
cat welcome.txt
echo hi | grep h
sort fruits.txt | uniq -c
seq 1 5 | awk '{s+=$1}END{print s}'
cat data.json | jq .tags
echo hi > /tmp/x.txt; cat /tmp/x.txt
open-image        # spawns the GUI image-viewer inline in the results pane
```

## Run it

```sh
npm run dev        # vite dev server — open the printed URL
npm run build      # production build into dist/
npm test           # the Chromium browser test (vitest run)
npm run typecheck
npm run lint
```

## How command loading works in the browser

Like `@mithic/example-shell`, this notebook does **not** spawn guests by URL.
The production resolvers map a command name to its built `dist` guest module
URL, which the kernel normally `import()`s inside a Worker/iframe — that works
in Node but not in an opaque-origin browser sandbox, where the guest's
transitive bare `@mithic/guest-runtime` import cannot be resolved. So
`src/commands.ts` statically imports every command's guest module through the
bundler (Vite `import.meta.glob`) and runs the matched guest **in-process** via
a custom kernel `GuestLauncher` (`InProcessCommandLauncher`), keyed by a
`command:<name>` sentinel from the composed resolver.

That same launcher delegates any **non-command** code (a real inline source
string or module URL) to a `DefaultGuestLauncher`, so the inline image-viewer
GUI guest still spawns on the runtime — that is how `open-image` mounts a real
`display: 'inline'` iframe. The image-viewer guest is embedded as an inline
source string (`IMAGE_VIEWER_GUEST`) because the opaque-origin iframe cannot
import `@mithic/*`.
