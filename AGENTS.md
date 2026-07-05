# Mithic — Agent Guidelines

## Project Overview

Mithic is an isomorphic, capability-based sandboxed **JavaScript** process runtime that runs identically in the browser and on native Node platforms. It provides a POSIX-style shell that itself runs as a regular sandboxed process, a capability-gated virtual filesystem (VFS) and network layer, pluggable isolation backends (iframe, Web Worker, QuickJS-WASM, isolated-vm), and a microkernel that brokers syscalls, IPC pipes, process lifecycle, and a sanitized Remote-DOM host for GUI processes.

npm scope is `@mithic/*`; core library packages are at version `2.0.0` (`@mithic/worker` is `0.1.0`).

> Mithic is **JS-first** (the Mithic 2.0 line, now on `main`). The earlier WASM/WASI-Preview-2 implementation is paused — its packages (`wasip2`, `process`, `wasm-transpile`, and the WASM variants of `shell`/`coreutils`/`commands`) live on the `wasm` branch, not here. Do not reference them as if present on the current tree.
>
> ("Isola" was an internal codename for an earlier iteration and must not appear as the product name — the product is Mithic.)

## Monorepo Structure

```
packages/
├── protocol/       @mithic/protocol       — wire/IPC types: errno + signals, SyscallRequest/Response, KernelEvent, Capability, ProcessInit/Limits, pipe protocol (leaf; no deps)
├── runtime/        @mithic/runtime        — pluggable execution backends (Worker, iframe [GUI], QuickJS, isolated-vm) + RuntimeCapabilities + selectBackend()
├── guest-runtime/  @mithic/guest-runtime  — in-sandbox guest API: createGuest(opts) → {pid, args, env, cwd, stdio streams, syscall, onSignal, onDomEvent, exit}; Remote-DOM client
├── kernel/         @mithic/kernel         — the Kernel: process lifecycle, IPC broker, capability manager, syscall dispatch, pipelines, Remote-DOM host
├── io/             @mithic/io             — VFS router + providers (memory/device/node-fs/opfs/caching), HTTP/socket abstractions, sync-bridge utils
├── shell/          @mithic/shell          — POSIX-style shell interpreter (lexer/parser/expander/executor/builtins) running as a regular Mithic process
├── coreutils/      @mithic/coreutils      — pure-TS Unix coreutils (71 commands, incl. getcap/setcap over fs/*xattr), one guest module per command, + 4 web-API utility executables (copy/csvcols/imgresize/imgconvert via OffscreenCanvas) + createCoreutilsResolver
├── commands/
│   ├── jq/         @mithic/jq             — pure-TS jq JSON processor as a sandboxed process (+ standalone ./engine)
│   └── curl/       @mithic/curl           — pure-TS curl-like HTTP client; all network via the capability-gated net/fetch syscall
├── server/         @mithic/server         — host-side Hono REST server: POST /exec runs sandboxed code (QuickJS relay path)
├── worker/         @mithic/worker         — Web Worker polyfill for Node.js (isomorphic `new Worker()`); built with tsc, tested with node --test
├── desktop/        @mithic/desktop        — host-side window manager for a browser OS: WindowManager + AppRegistry + drag/resize (iframe pointer-shield) + taskbar + geometry persistence + tier-1 textarea editor / tier-1 file-manager apps; zero third-party deps
└── examples/       (private)
    ├── shell/        @mithic/example-shell        — xterm.js browser terminal running @mithic/shell with the full coreutils + jq + curl suite
    ├── image-viewer/ @mithic/example-image-viewer — GUI Mithic process: drop-zone + <img> rendered in its own sandboxed iframe DOM
    ├── desktop/      @mithic/example-desktop      — minimalist browser OS: @mithic/desktop WM + terminal/editor/file-manager + a sandboxed image-viewer over one shared kernel + VFS
    └── lab/          @mithic/example-lab          — in-browser file-automation Lab (RFC 0001): installs utility executables into /usr/bin with manifest-sourced security.capability xattr caps, composes a shell-script workflow, RemoteDomHost blob: preview, OPFS persistence; demonstrates exec-from-VFS. `index.html` boots the shipped **image-tool** product page (`src/image-tool/`): an instrumented, privacy-first "resize & convert an image" GUI-guest page (IframeRuntime, opt-in `allow-downloads`) running a 2-utility `imgresize`→`imgconvert` `#!/bin/bash` workflow in-browser, with content-free first-party telemetry — the first Phase-1 single-utility demand-validation funnel (design: `docs/mithic/superpowers/specs/2026-07-05-image-tool-single-utility-page-design.md`)
```

**Dependency layering (bottom → top):** `protocol` → `runtime`/`guest-runtime`/`io` → `kernel` (uses runtime + io + protocol) → `shell`/`coreutils`/`jq`/`curl` (guests on guest-runtime) → `desktop` (host-side WM over kernel + runtime + io) → `server` and `examples` (compose kernel + runtime + io + shell + command + desktop packages). `worker` is standalone and consumed by `runtime` for Node Worker support.

> **Browser OS:** `@mithic/desktop` is a *host-side* windowing layer (it runs on the trusted host page, never in a sandbox) — the guest never calls into it. The one enabling kernel/runtime change is the per-spawn `display.container?: HTMLElement` on `SpawnOptions`/`DisplayOptions`, so each GUI guest's iframe is created inside its own window frame and **never reparented** (reparenting reloads the iframe and kills the guest). Design + ChromeOS-parity roadmap: `docs/isola/005-browser-os-design.md`.

**Command suite: 73 commands** — 71 coreutils (`COMMAND_NAMES` in `packages/coreutils/src/resolver.ts`, incl. `getcap`/`setcap`) + `jq` (`@mithic/jq`) + `curl` (`@mithic/curl`); plus 4 web-API utility executables (`copy`/`csvcols`/`imgresize`/`imgconvert`) shipped as guest modules but not in `COMMAND_NAMES`. The kernel owns the command namespace: a bare command name is mapped to spawnable guest code via `KernelOptions.resolveCommand(name, cwd, env)` — or, since RFC 0001, resolved from a `$PATH` VFS file first (exec-from-VFS).

## Build & Test

```shell
npm install                  # installs workspace deps (pure JS/TS — no cargo, no wasm-tools)
npm run build                # vite build across all workspaces (tsc for @mithic/worker)
npm test                     # vitest run across all projects (node + browser)
npm run test:node            # node-environment tests only
npm run test:browser         # browser-mode tests (Chromium via Playwright)
npm run test:node-native     # node --test guards NOT collected by vitest (*.node-test.ts) — real-Node non-Vite isomorphism (e.g. the OF1/G2 boot.imports launcher)
npm run lint                 # eslint
npm run typecheck            # tsc --noEmit per package
```

Individual package: run the same commands inside the package directory.

Test runner is **Vitest** (`vitest.config.ts`), with two projects:

- **`node`** — environment `node`; runs `*.test.ts` matched by the config's include allowlist (`packages/{protocol,runtime,guest-runtime,kernel,shell,coreutils,server}/src/**`, `packages/io/src/vfs/**`, `packages/io/src/net/**`, `packages/commands/*/src/**`, `packages/desktop/src/**`).
- **`browser`** — real Chromium via Playwright (headless); runs `*.browser.test.ts` (iframe sandboxing, DOM, MessagePort/ArrayBuffer transfer), `packages/desktop/src/**`, plus the example packages (`image-viewer`, `desktop`, `shell`).

The include globs are an **explicit allowlist**, not a `packages/*` sweep — `@mithic/io` net/utils (only `io/src/vfs/**` is in the allowlist) and `@mithic/worker` run via `node --test` through their own package `test` scripts and must not be picked up by vitest. Toolchain: TypeScript 6+, ESM-only, Vite 8, Vitest 3.2.

## Key Conventions

- **TypeScript 6+**, ESM-only (`"type": "module"`)
- **Vite** for library builds (produces `dist/`)
- **No comments unless the "why" is non-obvious**
- **Node.js >= 26.0** required

## Architecture Principles

- **Capability-gated** — Every privileged operation is a syscall brokered by the kernel. A process only acts on resources granted by its `Capability` set (`fs | net | ipc | process | env`); the `CapabilityManager` checks each `fs/*`, `net/fetch`, `ipc/*`, and `process/*` call before it reaches a provider. Guests never hold a raw socket or fd — e.g. `@mithic/curl` issues `net/fetch` and the kernel runs the capability check before invoking the `HttpClient`. Since RFC 0001 capabilities can also be **file metadata**: a `security.capability` xattr (serialized `Capability[]`) on an executable is the grant set at install time, and exec narrows it against the parent (Linux file-capabilities model). xattrs are themselves capability-gated (`fs/{get,set,list,remove}xattr`) and persisted via a per-mount `.mithic-meta.json` sidecar on OPFS/NodeFs; protocol exports `SECURITY_CAPABILITY_XATTR` / `encodeCapabilities` / `decodeCapabilities`.
- **Pluggable components** — VFS providers, HTTP/socket clients, and runtime backends are interfaces with injectable implementations, wired through `KernelOptions` (`runtime`, `vfs`, `httpClient`, `resolveCommand`, `launcher`/`relayLauncher`, `onDomMutate`). SOLID-style loose coupling for testability and isomorphism.
- **Isomorphic by design** — The same kernel, VFS, and command suite run unchanged in the browser and on Node. Backends differ in capability, not in API:
  - **Worker** (`WorkerRuntime`) — true parallelism via Web Workers; transferable MessagePort pipes (direct pipes); no resource limits.
  - **iframe** (`IframeRuntime`) — the only `gui: true` backend (Remote-DOM rendering in an opaque-origin sandbox); transferable, direct pipes; not interruptible.
  - **QuickJS** (`QuickJSRuntime`) — deterministic WASM interpreter; hard memory cap + CPU/wall-clock interrupt budget. Not transferable, so the kernel uses the **relay path** (`RelayContext.onSyscall`) — capability checks still run in-kernel.
  - **isolated-vm** (`IvmRuntime`) — hard V8 memory cap; wall-clock (not CPU-time) timeout, so `cpuLimit` is honestly advertised as false.

  `selectBackend(policy, context)` picks one against each backend's `RuntimeCapabilities` (`gui, transferable, directPipes, deterministic, memoryLimit, cpuLimit, parallelism, interruptible`), default fallback order `['worker','iframe','quickjs','ivm']`.
- **Guest loading is ESM-from-VFS (OF1/G2/G6 — [spec](../docs/mithic/superpowers/specs/2026-07-04-esm-guest-loading-and-iframe-csp.md))** — a hand-authored `#!/bin/node` **ESM** guest runs byte-for-byte from any VFS path in-browser. The Worker + iframe bootstraps mint an **in-sandbox `blob:` module** from the guest bytes and `await import()` it (there is no `eval` guest-load path), resolving the entrypoint as `mod.default ?? globalThis.__mithic_default` (covers hand-authored ESM AND `?bundle` IIFE guests). `@mithic/*` deps resolve via a **host-curated `boot.imports`** map of in-sandbox `blob:` module URLs (`KernelOptions.guestImports` → `boot.imports`; frozen; a missing name is a fail-loud `import(undefined)`) — not bare specifiers, no source rewrite. Node's in-process launcher materializes the same via `file://` temp modules. **Security (browser):** the iframe carries a locked CSP (`DEFAULT_GUEST_CSP` in `iframe-bootstrap.ts`: `script-src '…' blob:` for the module import, **explicit `worker-src 'none'`**, passive `img/media/font-src blob: data:` local-only, `connect-src 'none'` — network is the `net/fetch` syscall — plus a `RTCPeerConnection` bootstrap shim), compilable per-guest from the `AppManifest` (`manifestCsp` → `SpawnInit.csp`); `RemoteDomHost` rejects remote-origin `src`/`srcset`/`poster`/`href` host-side. The Worker spawns from a `data:` URL (forward-compatible opaque origin — null at Chrome 150 `kDataUrlWorkerOpaqueOrigin`; same-origin to the host pre-150, a transitional state; outbound egress is an accepted residual). Relay backends (QuickJS/ivm) are ESM-out-of-scope (async-IIFE `eval`, no module loader).
- **Everything is a file / POSIX shell** — `@mithic/shell` mirrors Bash (builtin-first dispatch; non-builtins spawned via `process/spawn` and `process/pipeline`), with POSIX `set` options (`errexit`, `nounset`, `xtrace`, `pipefail`, `noclobber`). Storage, devices, and IPC are all VFS mounts. Shell I/O is **byte-stream based**: `CommandIO.stdin`/`BuiltinContext.stdin` are `ReadableStream<Uint8Array>` and output goes through an `OutputSink` (callable text sink + `writeBytes`), so `cat`/`read`/`mapfile` stream and a guest's binary stdout reaches the terminal byte-exact. In-process compound pipelines run stages concurrently over identity `TransformStream`s (EPIPE on early exit; a builtin infinite producer has a broken-pipe backstop). Supports the full `${var@OP}` transform set (`@Q @U @u @L @E @a @A @P @K @k`), `coproc` (relay backends via the `process/coproc` syscall), `<&`/`<>`/`<<<` redirects, and UDP/TCP over `/dev/udp`·`/dev/tcp` (`exec 3<>/dev/udp/host/port` + datagram-aware `read`).
- **Disposable ownership convention** — When a component receives a `Disposable` resource, ownership must be explicit:
  - **Owned**: The receiver calls `[Symbol.dispose]()` when done. The resource's lifetime is tied to the receiver.
  - **Borrowed**: The receiver uses the resource but does NOT dispose it. The caller retains ownership. For streams, use `borrow()` to make this explicit — the borrow is a non-ref-counted view whose dispose is a no-op.

  Example: a guest owns its stdio streams (the pipe-protocol `ReadableStream`/`WritableStream` over `MessagePort` from `@mithic/guest-runtime`) and disposes them on exit, which propagates EOF / broken-pipe (`EPIPE`) to the peer.

## When Editing

**The one rule: `npm run build` before ANY test run or verification. No exceptions.**

Many tests import from `dist/`. Running tests without building first risks testing stale compiled code — results may be meaningless regardless of pass/fail. This applies after every action that changes what's in the working tree:

- After editing source files
- After `git stash` or `git stash pop`
- After `git checkout` or `git switch`
- After pulling or rebasing

**Do NOT** `git stash` + `npm test` to check if tests "were already broken" — this tests whatever stale JS was last built, not the stashed-to state. If you need a baseline, do: `git stash && npm run build && npm test`.

The verification sequence is always run from the **monorepo root**: `npm run build && npm run typecheck && npm test && npm run test:node-native`. This builds and tests all packages — don't limit to a single package, since changes often have cross-package effects. (`test:node-native` runs the `*.node-test.ts` guards under real `node --test`; vitest deliberately does **not** collect them — they cover Node-only, non-Vite paths like the in-process launcher's `boot.imports` materialization.)

### Tests

- Every code change must include tests covering the new or modified behavior — happy path, edge cases, and error conditions.
- When fixing a bug, add a regression test that reproduces it before applying the fix.
- Do not consider work done until `npm run build && npm run typecheck && npm test && npm run test:node-native` passes from the monorepo root.

### Other guidelines

- Prefer editing existing files over creating new ones.
