# @mithic/protocol

Wire-protocol types shared across the Isola runtime. This package is pure type
and guard definitions — the single source of truth for the messages that flow
between the kernel, a runtime backend, and a sandboxed guest.

## What's in it

- **Process** — `ProcessInit`, `Capability` (`{ type: 'fs', paths, operations }`, …),
  `ProcessLimits`, `Signal`, and the `isProcessReady` / `isProcessExit` guards.
- **Syscall** — `SyscallRequest`, `SyscallResponse`, and `isSyscallResponse`.
- **Kernel events** — `KernelEvent` (e.g. `signal`, `dom/event`) and `isKernelEvent`.
- **Pipe + errno** — the credit-based pipe message protocol and POSIX errno helpers.

## Quick start

```ts
import { isSyscallResponse, type Capability, type ProcessInit } from '@mithic/protocol';

const caps: Capability[] = [
  { type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] },
];

function handle(msg: unknown) {
  if (isSyscallResponse(msg) && msg.ok) {
    // msg.result is the syscall return value
  }
}
```

The kernel and guest never hand-roll these shapes — import the types and guards
from here so both sides stay compatible.
