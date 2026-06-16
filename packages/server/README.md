# @mithic/server

Isola HTTP API server. Exposes sandboxed process execution over a single
`POST /exec` Hono endpoint. Each request spawns a fresh QuickJS isolate,
captures stdout/stderr, enforces resource limits, and returns the result as
JSON — with no shared state between calls.

## Why QuickJS

QuickJS enforces `timeoutMs` and `cpuMs` limits via a WASM interrupt handler
(not a best-effort race), is fully portable (no SharedArrayBuffer / COOP-COEP
headers needed), and runs on the same JS thread without requiring Workers.

## Quick start

```ts
import { createApp } from '@mithic/server';

const app = createApp();

// With Hono's built-in Node adapter (Bun / Deno also work):
import { serve } from '@hono/node-server';
serve({ fetch: app.fetch, port: 3000 });
```

### POST /exec

```jsonc
// Request
{
  "code": "const r = __isola_syscall(JSON.stringify({id:1,call:'process/getpid',args:{}})); globalThis.__isola_syscall(JSON.stringify({id:2,call:'process/exit',args:{code:0}}))",
  "env": { "FOO": "bar" },
  "limits": {
    "timeoutMs": 5000,
    "cpuMs": 2000,
    "memoryMb": 64,
    "maxOutputBytes": 65536
  }
}

// Response
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "limitHit": false
}
```

`limitHit` is `true` when any limit is configured and the process exits
non-zero (covers timeout, OOM, and `maxOutputBytes` overflow).

## Testing

```sh
npm test                      # vitest — tests the Hono app via app.request()
```

The kernel and QuickJS runtime are imported from `@mithic/kernel` and
`@mithic/runtime/backends/quickjs` respectively.
