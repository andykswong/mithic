# @mithic/guest-runtime

The Isola guest-side runtime. Runs **inside** the sandboxed process (Worker,
iframe, QuickJS, or isolated-vm). It wires the host-supplied `MessagePort`
control channel into the typed `Guest` interface that application code and WASM
shims depend on.

## What's in it

- **`createGuest`** — top-level factory. Consumes the `control` port + stdio
  preopen ports from `ProcessInit` and returns a `Guest` with `stdin`,
  `stdout`, `stderr`, `syscall`, `onSignal`, `onDomEvent`, and `exit`.
- **`portToReadable` / `portToWritable`** — credit-based pipe adapters.
  Implement the sliding-window flow-control protocol from `@mithic/protocol`
  over a `MessagePort`, with EPIPE/end wake-up for parked writers.
- **`SyscallClient`** — correlates outgoing syscall requests (by `id`) with
  arriving responses from the kernel. Supports an optional `timeoutMs` to
  reject hung calls with `ETIMEDOUT`.
- **`MutationSerializer`** — serialises virtual DOM mutations to the kernel's
  Remote DOM protocol (`dom/mutate` syscall).
- **`FdTable`** — POSIX-style file descriptor table for the guest's open files.

## Quick start

```ts
// Inside a Worker / iframe / QuickJS guest entry point:
import { createGuest } from '@mithic/guest-runtime';

// The host passes the boot object when it spawns the process.
const guest = createGuest(boot);

const enc = new TextEncoder();
const w = guest.stdout.getWriter();

// Syscalls go through the kernel's capability checker.
const { pid } = await guest.syscall('process/getpid', {}) as { pid: number };
await w.write(enc.encode(`I am pid ${pid}\n`));

guest.onSignal((sig) => {
  if (sig === 'SIGTERM') guest.exit(0);
});

await w.close();
guest.exit(0);
```

### Opt-in per-call timeout

```ts
import { SyscallClient } from '@mithic/guest-runtime/syscall-client';

// Reject any syscall that receives no reply within 5 s.
const client = new SyscallClient(transport, { timeoutMs: 5000 });
```

The host side of this protocol lives in `@mithic/kernel` (`Kernel`).
