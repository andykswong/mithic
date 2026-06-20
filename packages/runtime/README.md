# @mithic/runtime

Pluggable execution backends for Mithic guests. A `Runtime` is where a guest
module actually runs; the kernel talks to all of them through one interface
(`spawn` / `kill` / `postMessage` / `onMessage`), so the same kernel works over
a Web Worker, a sandboxed iframe, QuickJS, or isolated-vm. Each backend
advertises a `RuntimeCapabilities` descriptor, and `selectBackend` picks one that
satisfies a policy.

## What's in it

- **`Runtime`** — the backend interface every implementation conforms to.
- **`RuntimeCapabilities`** — the eight-flag descriptor the kernel reads to pick
  a spawn path (and `selectBackend` matches against).
- **`selectBackend`** — policy-driven backend selection over the set available in
  the current environment.
- **Four backends** — `WorkerRuntime`, `IframeRuntime`, `QuickJSRuntime`,
  `IvmRuntime`, each on its own subpath export.

## The `Runtime` interface

```ts
interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  spawn(code: string | URL, options: SpawnOptions): Promise<ProcessHandle>;
  kill(handle: ProcessHandle, signal: Signal): void;
  postMessage(handle: ProcessHandle, msg: SyscallResponse | KernelEvent, transfer?: Transferable[]): void;
  onMessage(handle: ProcessHandle, cb: (msg: SyscallRequest) => void): void;
  isAlive(handle: ProcessHandle): boolean;
  dispose(handle: ProcessHandle): void;
}
```

`spawn` takes either an inline source string or a module `URL` (URL entries are
loaded via `await import(...)`; the isolated-vm backend does not support URL
entries). `SpawnOptions` carries the `ProcessInit`, an optional `transfer` list
of `Transferable`s (MessagePorts for the control + stdio channels), and an
optional `display` placement (`mode: 'hidden' | 'inline' | 'window' | 'fullscreen'`
plus `width`/`height`/`title`). `postMessage`/`onMessage` only carry meaning on
backends with `transferable`/`directPipes` — on QuickJS and isolated-vm they are
no-ops, and syscalls flow through the kernel's relay path instead.

## `RuntimeCapabilities`

Eight booleans describing what a backend can do:

| Flag | Meaning |
| --- | --- |
| `gui` | The guest gets a real DOM (Remote DOM rendering). |
| `transferable` | MessagePorts/ArrayBuffers can be transferred across the boundary. |
| `directPipes` | Guest↔guest pipes are wired directly (zero-hop), not relayed. |
| `deterministic` | Execution is reproducible (no host clock/entropy leakage by default). |
| `memoryLimit` | A hard memory cap can be enforced. |
| `cpuLimit` | A CPU-time/opcode budget can be enforced (distinct from wall-clock). |
| `parallelism` | Runs off the main JS thread, truly in parallel. |
| `interruptible` | Execution can be forcibly aborted mid-run. |

## Backends

| Import | Backend | gui | transferable | directPipes | deterministic | memoryLimit | cpuLimit | parallelism | interruptible |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `@mithic/runtime/backends/worker` | `WorkerRuntime` | – | yes | yes | – | – | – | yes | yes |
| `@mithic/runtime/backends/iframe` | `IframeRuntime` | **yes** | yes | yes | – | – | – | yes | – |
| `@mithic/runtime/backends/quickjs` | `QuickJSRuntime` | – | – | – | **yes** | **yes** | **yes** | – | yes |
| `@mithic/runtime/backends/ivm` | `IvmRuntime` | – | – | – | – | **yes** | – | yes | yes |

### `WorkerRuntime` — `@mithic/runtime/backends/worker`

One Web Worker per process. True parallelism and transferable MessagePorts, so
the kernel wires direct (zero-hop) pipes between guests. No resource limits.
Constructed with an optional `WorkerFactory` (the default uses a Blob/`data:`
URL bootstrap; the `@mithic/worker` polyfill makes `new Worker(url)` work under
Node). **Use it** as the default backend on the main thread when COOP/COEP-free
Workers are available and you want parallelism.

### `IframeRuntime` — `@mithic/runtime/backends/iframe`

The only **GUI-capable** backend. Each process runs inside a sandboxed
`<iframe sandbox="allow-scripts">` (no `allow-same-origin`, so an opaque origin
with no access to parent DOM or storage) and has a real DOM the kernel renders
into via Remote DOM. Transferable ports and direct pipes, like Worker, but
**not interruptible**. The constructor takes an optional `{ container }` where
visible (non-hidden) iframes mount; hidden iframes always live off-screen on
`document.body`. `SpawnOptions.display.mode` controls placement. **Use it** for
GUI processes in the browser (e.g. the image-viewer example).

### `QuickJSRuntime` — `@mithic/runtime/backends/quickjs`

Runs guest JS in an embedded quickjs-emscripten WASM sandbox. **Deterministic**
and resource-limited: `memoryLimit` via `setMemoryLimit` (a hard QuickJS heap
cap; OOM surfaces as exit code 137), and `cpuLimit` via an interrupt handler that
honors *both* a wall-clock `timeoutMs` deadline and a CPU-op budget derived from
`cpuMs` (an opcode-count proxy, since QuickJS exposes no true CPU-time counter).
Because it has no transferable ports (`transferable: false`, `directPipes:
false`), the kernel uses its **relay path** — guest syscalls are delivered via an
asyncified `__mithic_syscall` bridge to a host `onSyscall` callback (see
`QuickJSSpawnOptions`), and all capability checks still run in-kernel.
Constructed via the async factory `await QuickJSRuntime.create()`. **Use it** for
untrusted code that needs hard memory/CPU caps and reproducibility, on any
platform (no Workers or SharedArrayBuffer required).

### `IvmRuntime` — `@mithic/runtime/backends/ivm`

True V8 isolate sandboxing via the native `isolated-vm` Node addon. `memoryLimit`
is enforced via the isolate's `memoryLimit` option (hard V8 heap cap that
terminates the isolate on OOM). `cpuLimit` is intentionally **`false`**:
`context.eval({ timeout })` enforces a *wall-clock* deadline, not a CPU-time
budget, so advertising a CPU limit would be dishonest. URL module entries are not
supported. `isolated-vm` is an **optional dependency** — there is no top-level
import, so the package builds and typechecks even when the addon is absent; call
`isIvmAvailable()` to probe, and `await IvmRuntime.create(memoryLimitMb?)` to
construct (default 128 MiB). Requires isolated-vm v7+ for Node 26+. **Use it** for
hard-isolated server-side execution on Node.

## Selecting a backend

```ts
import { selectBackend } from '@mithic/runtime';

const name = selectBackend(
  { requirements: { gui: true } },             // policy
  { available: ['worker', 'iframe', 'quickjs'] } // backends present here
);
// → 'iframe' (the only available backend with gui: true)
```

`selectBackend(policy, context)` walks candidates and returns the first
**available** backend whose `RuntimeCapabilities` satisfy `requirements` (a
`Partial<RuntimeCapabilities>` — every listed flag must match exactly). If none
qualifies, it throws.

- `preferred` is tried first, then the rest of the order.
- `fallbackOrder` defaults to `['worker', 'iframe', 'quickjs', 'ivm']`.
- `requirements` filters by capability; omit it to accept any available backend.
- `context.available` is the set of backends the caller knows can run here (e.g.
  iframe only in a DOM, ivm only when the addon loaded).

## Quick start

```ts
import { IframeRuntime } from '@mithic/runtime/backends/iframe';

// GUI-capable runtime; mount visible iframes into a chosen container.
const runtime = new IframeRuntime({ container: document.getElementById('results')! });

// Spawn placement is controlled via SpawnOptions.display:
//   { mode: 'hidden' | 'inline' | 'window' | 'fullscreen', width?, height?, title? }
```

You usually don't call `spawn` directly — hand the runtime to a `Kernel`
(`new Kernel({ runtime, vfs })`) and use `kernel.spawn(...)`, which threads
`display` straight through to the runtime and routes every syscall through the
kernel's capability checker. The guest side of the protocol lives in
`@mithic/guest-runtime` (`createGuest`).
