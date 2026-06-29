# @mithic/guest-runtime

The Mithic guest-side runtime. Runs **inside** the sandboxed process (Worker,
iframe, QuickJS, or isolated-vm). It wires the host-supplied `MessagePort`
control channel and stdio preopen ports into the typed `Guest` interface that
application code (the shell, coreutils, jq, curl, GUI processes) depends on.

The host side of this protocol lives in `@mithic/kernel` (`Kernel`).

## What's in it

- **`createGuest`** — top-level factory. Consumes the `control` port, the
  `ProcessInit`, and the stdio preopen ports, and returns a `Guest` with `pid`,
  `args`, `env`, `cwd`, `stdin`, `stdout`, `stderr`, `syscall`, `fetch`, `fs`,
  `onSignal`, `onDomEvent`, and `exit`. It multiplexes the control port, routing
  syscall responses to the `SyscallClient` and kernel events (`signal`,
  `dom/event`) to the registered listeners.
- **`SyscallClient`** — correlates outgoing syscall requests (by `id`) with
  arriving responses from the kernel. Supports an optional `timeoutMs` to reject
  hung calls with `ETIMEDOUT`.
- **`Transport` / `MessagePortTransport`** — the minimal `send` / `onMessage` /
  `close` adapter the `SyscallClient` rides on. `MessagePortTransport` wraps a
  raw `MessagePort`.
- **`FdTable`** — POSIX-style file-descriptor table for the guest's open files,
  starting at fd 3 (fds 0/1/2 are the stdio preopens).
- **`MutationSerializer` / `VNode` / `DomMutation`** — virtual-DOM helpers that
  serialise mutations to the kernel's Remote DOM protocol (`dom/mutate`).
  Exported both from the package root and the `./remote-dom` subpath.
- **`portToReadable` / `portToWritable`** — credit-based pipe-protocol stream
  adapters, exported from the **`./streams`** subpath (see below).

## `createGuest`

```ts
import { createGuest } from '@mithic/guest-runtime';
import type { ProcessInit } from '@mithic/protocol';

// The runtime backend hands these to the guest entry point at boot:
//   control       — the MessagePort for syscalls + kernel events
//   init           — the ProcessInit (pid, args, env, cwd, limits, …)
//   preopenPorts   — fd → MessagePort map; 0=stdin, 1=stdout, 2=stderr
const guest = createGuest({ control, init, preopenPorts });

const enc = new TextEncoder();
const w = guest.stdout.getWriter();

// Syscalls go through the kernel's capability checker.
const pid = await guest.syscall('process/getpid', {}) as number;
await w.write(enc.encode(`I am pid ${guest.pid} (${pid})\n`));

guest.onSignal((sig) => {
  if (sig === 'SIGTERM') guest.exit(0);
});

await w.close();
guest.exit(0);
```

`exit(code)` posts an `exit` message on the control port and closes the
`SyscallClient`, rejecting any in-flight syscalls.

When a preopen port is absent the fd is `/dev/null`-like: `stdin` becomes an
immediately-closed `ReadableStream` (EOF on first read) and `stdout`/`stderr`
become null-sink `WritableStream`s whose writes are silently discarded — so a
headless process that only uses syscalls never throws on stdio.

### GUI processes

A GUI guest (running in the iframe backend) additionally subscribes to
`dom/event` kernel events forwarded from the host:

```ts
guest.onDomEvent?.((ev) => {
  // ev: { nodeId, eventType, payload }
  // The remote-dom layer dispatches this to the matching VNode listener.
});
```

`onDomEvent` is optional so lightweight stub guests (e.g. tests that only
serialise mutations) need not implement it.

### `guest.fs` — File System Access surface

`guest.fs` is a `StorageManager`-shaped object (mirroring the web standard
`navigator.storage`), layered over the `fs/*` syscalls and minted lazily on
first use. It is **not** a `FileSystemDirectoryHandle` directly — you obtain a
handle from it:

```ts
const root = await guest.fs.getDirectory();        // the VFS root `/`
const cwd  = await guest.fs.getCurrentDirectory(); // the handle for guest.cwd
```

`getDirectory()` yields the VFS root (the web-standard entry point);
`getCurrentDirectory()` is a Mithic extension that yields the handle for this
process's `cwd`, so relative argv paths resolve the Unix way. Both return a
`GuestDirectoryHandle` exposing the WHATWG File System Access API
(`getFileHandle`/`getDirectoryHandle`/`removeEntry`/`getFile`/`createWritable`,
plus `keys`/`values`/`entries` async iterators); the integer fd stays internal.

For argv-path handling, the package also exports cwd-aware helpers that bridge an
absolute-or-relative path to the name-relative handle API:

```ts
import { readPath, writePath } from '@mithic/guest-runtime';

const bytes = await readPath(guest, 'notes.txt');        // relative → guest.cwd
await writePath(guest, '/tmp/out.bin', bytes);           // creates missing dirs
```

## `./streams` — pipe-protocol stream adapters

```ts
import { portToReadable, portToWritable } from '@mithic/guest-runtime/streams';

const readable = portToReadable(port); // ReadableStream<Uint8Array>
const writable = portToWritable(port); // WritableStream<Uint8Array>
```

These bridge a `MessagePort` to the Web Streams API and implement the
credit-based flow-control protocol from `@mithic/protocol`:

- **`portToWritable`** starts at 0 credit and waits for `credit` messages from
  the reader before flushing buffered data. Writes are coalesced and flushed
  when the buffer reaches `PIPE_FLUSH_BYTES` or after `PIPE_FLUSH_MS`; chunks at
  or above `TRANSFER_THRESHOLD_BYTES` are sent as transferables. An `end` or
  `error` (`EPIPE`) message from the reader wakes all parked writers so they
  never hang waiting for credit that will never arrive.
- **`portToReadable`** grants a sliding credit window of `INITIAL_CREDIT_BYTES`,
  replenishing only the bytes the consumer has actually drained since the last
  grant. A slow consumer that stops pulling stops replenishing, so the writer
  exhausts its credit and `desiredSize` drops to ≤0 — genuine backpressure.

`createGuest` uses these internally to build `stdin` / `stdout` / `stderr` from
the stdio preopen ports.

## Opt-in per-call timeout

`SyscallClient` (exported from the package root) accepts a `timeoutMs`:

```ts
import { SyscallClient, MessagePortTransport } from '@mithic/guest-runtime';

const transport = new MessagePortTransport(controlPort);
// Reject any syscall that receives no reply within 5 s with code 'ETIMEDOUT'.
const client = new SyscallClient(transport, { timeoutMs: 5000 });
```
