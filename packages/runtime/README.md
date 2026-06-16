# @mithic/runtime

Pluggable execution backends for Mithic guests. A `Runtime` is where a guest
module actually runs; the kernel talks to all of them through one interface
(`spawn` / `kill` / `postMessage` / `onMessage`), so the same kernel works over
a Web Worker, a sandboxed iframe, QuickJS, or isolated-vm.

## Backends

| Import | Backend | Notes |
| --- | --- | --- |
| `@mithic/runtime/backends/worker` | `WorkerRuntime` | Web Worker per process. True parallelism, transferable ports. |
| `@mithic/runtime/backends/iframe` | `IframeRuntime` | Sandboxed, opaque-origin `<iframe>`. **GUI-capable** — the guest has a real DOM. Supports `display` placement. |
| `@mithic/runtime/backends/quickjs` | `QuickJSRuntime` | Deterministic, memory/CPU-limited. Non-transferable (kernel uses the relay path). |
| `@mithic/runtime/backends/ivm` | `IvmRuntime` | isolated-vm (Node). Memory/CPU limits. |

Each backend advertises its `capabilities` (`gui`, `transferable`, `directPipes`,
`deterministic`, memory/cpu limits, `parallelism`, `interruptible`) so the kernel
picks the right spawn path.

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
`display` straight through to the runtime.
