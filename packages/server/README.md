# @mithic/server

Host-side HTTP API for Mithic: a [Hono](https://hono.dev) app that runs
sandboxed Mithic processes server-side over a single `POST /exec` endpoint. Each
request boots a fresh kernel over a QuickJS isolate, runs the supplied guest code
under resource limits, captures stdout/stderr, and returns the result as JSON —
with no shared state between requests.

Because it builds on Hono, the app runs anywhere Hono runs: Node.js, edge
runtimes (Cloudflare Workers, Deno, Bun), and any host with a `fetch`-style
adapter.

## Responsibilities

- **Sandboxed execution** — spawns guest code through `@mithic/kernel` on a
  per-request `QuickJSRuntime`; the kernel remains the trust boundary, so every
  guest syscall is capability-checked in-kernel regardless of backend.
- **Resource limits** — forwards `ProcessLimits` (`timeoutMs`, `cpuMs`,
  `memoryMb`, `maxOutputBytes`) to the kernel and reports whether a limit was
  hit.
- **Request validation** — rejects malformed bodies, empty `code`, unsupported
  `stdin`, and non-positive limit values with `4xx` before any process is
  spawned.
- **Isolation** — each request gets its own kernel, QuickJS runtime, and an
  in-memory VFS (`FileSystemRouter` + `MemoryFsProvider` mounted at `/`); nothing
  is shared across calls.

## Why QuickJS

The server uses the QuickJS backend (`@mithic/runtime/backends/quickjs`) because:

- It enforces `timeoutMs` and `cpuMs` via a WASM interrupt handler — real
  enforcement, not a best-effort race — making timeout behavior deterministic on
  Node.
- It is fully portable: no SharedArrayBuffer and no COOP/COEP headers needed.
- It runs on the same JS thread, so no Worker is required (works in any Node
  process without special flags).

Guest code therefore uses the QuickJS relay protocol — calling
`__mithic_syscall(...)` directly — rather than `@mithic/guest-runtime`'s
MessagePort path. A `QuickJSRelayLauncher` bridges the kernel's `RelayContext` to
`QuickJSRuntime.spawn()`: `pipe/write` is routed to stdout/stderr capture,
`process/exit` closes the pipes and reports the exit code, `process/getpid`
returns the assigned pid, and every other syscall is routed back through the
kernel (`ctx.onSyscall`) where capability checks run.

## Exports

```ts
import { createApp } from '@mithic/server';
import type { ExecRequest, ExecResponse } from '@mithic/server';
```

- **`createApp(): Hono`** — builds and returns the Hono app. Exported separately
  from any server binding so tests can drive it via `app.request()` without
  opening a TCP socket.
- **`ExecRequest` / `ExecResponse`** — the request/response shapes for `/exec`.

## Quick start

```ts
import { createApp } from '@mithic/server';
import { serve } from '@hono/node-server';

const app = createApp();
serve({ fetch: app.fetch, port: 3000 });
```

## `POST /exec`

Runs one guest program and returns its captured output. The request body is
limited to **1 MiB** (`413` on overflow).

### Request — `ExecRequest`

| Field    | Type                     | Notes                                                                 |
|----------|--------------------------|-----------------------------------------------------------------------|
| `code`   | `string` (required)      | Guest source. Uses the QuickJS relay (`__mithic_syscall`) directly.   |
| `env`    | `Record<string, string>` | Environment variables forwarded to the guest. Optional.               |
| `limits` | `ProcessLimits`          | Resource limits for this execution. Optional.                         |
| `stdin`  | `string`                 | **Not yet supported** — passing it returns `400`. Use `env` instead.  |

`limits` accepts the `ProcessLimits` fields from `@mithic/protocol`. The server
validates `timeoutMs`, `cpuMs`, `memoryMb`, and `maxOutputBytes`: each, if
present, must be a finite positive number, otherwise the request is rejected with
`400` rather than silently clamped.

```jsonc
{
  "code": "globalThis.__mithic_syscall(JSON.stringify({ id: 1, call: 'pipe/write', args: { fd: 1, data: 'hello\\n' } })); globalThis.__mithic_syscall(JSON.stringify({ id: 2, call: 'process/exit', args: { code: 0 } }));",
  "env": { "FOO": "bar" },
  "limits": {
    "timeoutMs": 5000,
    "cpuMs": 2000,
    "memoryMb": 64,
    "maxOutputBytes": 65536
  }
}
```

### Response — `ExecResponse`

| Field      | Type      | Notes                                                          |
|------------|-----------|----------------------------------------------------------------|
| `exitCode` | `number`  | Exit code reported by the guest (or `137` for OOM / SIGKILL).  |
| `stdout`   | `string`  | Captured stdout, decoded as UTF-8.                             |
| `stderr`   | `string`  | Captured stderr, decoded as UTF-8.                            |
| `limitHit` | `boolean` | `true` when a limit was configured and the process exited non-zero. |

```jsonc
{
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "limitHit": false
}
```

### `limitHit` semantics

`limitHit` is `true` when at least one limit was configured **and** the process
exited non-zero. This single flag covers all enforcement paths:

- `timeoutMs` / `cpuMs` — the QuickJS interrupt handler throws, exiting with
  code `1`.
- `memoryMb` OOM — exits with `137`.
- `maxOutputBytes` overflow — the kernel sends SIGKILL, exiting with `137`.

If no limits were set, `limitHit` stays `false` even when the guest exits
non-zero (a plain program error is not a limit hit).

### Status codes

| Status | When                                                                           |
|--------|--------------------------------------------------------------------------------|
| `200`  | Execution completed (the result, including a non-zero `exitCode`, is in the body). |
| `400`  | Invalid JSON, empty/non-string `code`, `stdin` provided, or a non-positive limit value. |
| `413`  | Request body exceeds 1 MiB.                                                    |
| `500`  | Internal execution error (e.g. the kernel threw); any spawned process is killed. |

## Testing

```sh
npm test    # vitest — exercises the Hono app via app.request() (no socket)
```

> **Note:** stdin and warm-VM pooling are not yet implemented. Each request
> currently creates a fresh `QuickJSRuntime`; the WASM module is loaded once and
> shared, so per-request overhead is a new QuickJS runtime + context.
