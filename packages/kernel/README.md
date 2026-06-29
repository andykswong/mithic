# @mithic/kernel

The Mithic kernel: a singleton that ties together process lifecycle, IPC,
capabilities, and syscall dispatch over a pluggable runtime backend. It is the
trust boundary — every guest syscall is routed through the kernel's dispatcher,
where capability checks run, regardless of which backend the guest runs on.

## Architecture

The `Kernel` is a thin orchestrator over four collaborators it owns:

- **`ProcessManager`** (`kernel.processes`) — pid allocation, process state, exit
  status, and `wait()`/reaping.
- **`IpcBroker`** (`kernel.ipc`) — mints credit-based `MessageChannel` pipes and
  resolves named IPC listeners.
- **`CapabilityManager`** (`kernel.capabilities`) — grants, narrows, and checks
  capabilities (`fs` / `net` / `ipc` / `process` / …) per pid.
- **`SyscallDispatcher`** (`kernel.dispatcher`) — the single `switch` that routes
  every guest syscall to a handler after the in-kernel capability check.

The kernel wires a `Runtime` backend (`@mithic/runtime`) underneath. For a
**transferable** backend (Worker, iframe) it mints a control `MessageChannel`,
keeps `port1`, and transfers `port2` plus the stdio ports into the sandbox; the
guest sends syscall requests and `ready`/`exit` lifecycle messages over that one
control port. For a **non-transferable** backend (QuickJS,
`capabilities.directPipes === false`) it uses the **relay path** instead — see
[GuestLauncher](#guestlauncher--how-a-guest-actually-starts).

## Responsibilities

- **Process lifecycle** — `spawn`, `runPipeline`, `wait`, `kill`, pid allocation,
  reaping, a backend-agnostic wall-clock timeout watchdog.
- **IPC** — mints credit-based pipes; wires zero-hop guest→guest pipelines.
- **Capabilities** — grants and narrows capabilities against the parent process.
- **Syscall dispatch** — VFS (`fs/*`, incl. `fs/{get,set,list,remove}xattr`),
  process (`process/*`, incl. exec-from-VFS resolution), IPC (`ipc/*`),
  network (`net/fetch`), and optional `dom/mutate`.
- **GUI** — threads `display` placement to the runtime; hosts Remote DOM.

## Quick start

```ts
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

const vfs = new FileSystemRouter();
await vfs.mount('/', new MemoryFsProvider());

const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

// Spawn a guest module (inline source string or a module URL).
const { pid, stdout } = await kernel.spawn(guestCode, {
  args: ['prog'],
  capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }],
  captureStdout: true,
  display: { mode: 'inline', width: 800, height: 600 }, // GUI placement (iframe runtime)
});

const { code } = await kernel.wait(pid);
const out = new TextDecoder().decode(await stdout!);
```

The guest side of this protocol lives in `@mithic/guest-runtime` (`createGuest`).

## Public API

```ts
class Kernel {
  readonly processes: ProcessManager;
  readonly capabilities: CapabilityManager;
  readonly ipc: IpcBroker;
  readonly dispatcher: SyscallDispatcher;

  constructor(options: KernelOptions);

  spawn(code: string | URL, init?: SpawnInit): Promise<SpawnResult>;
  runPipeline(stages: PipelineStage[]): Promise<PipelineResult>;
  wait(pid: number): Promise<WaitResult>;
  kill(pid: number, signal?: Signal): void; // default 'SIGKILL'
}
```

### `KernelOptions`

| Field | Purpose |
| --- | --- |
| `runtime` | The execution backend the kernel spawns guests on (required). |
| `vfs` | `FileSystemProvider` backing all `fs/*` syscalls (required). |
| `onDomMutate?` | Handler for `dom/mutate` batches (typically `RemoteDomHost.applyMutations`). Unset → `dom/mutate` returns `ENOSYS`. |
| `launcher?` | How a guest module is started. Defaults to `DefaultGuestLauncher`. |
| `resolveCommand?` | Maps a bare command **name** (`cat`) → spawnable guest code for `process/spawn`. The kernel owns the command namespace. |
| `httpClient?` | Backs the capability-gated `net/fetch` syscall. Defaults to `FetchHttpClient`. Pass a disabled client to turn off networking. |
| `relayLauncher?` | Required for non-transferable backends (e.g. QuickJS); drives I/O over relay callbacks instead of port transfer. |

### `spawn(code, init)`

Spawns one guest. `code` is either an inline ESM source string or a module
`URL`. Notable `SpawnInit` fields:

- `args`, `env`, `cwd`, `ppid` — process environment. `ppid` defaults to `0`
  (the kernel).
- `capabilities` — requested grants. **Narrowed** against the parent unless the
  parent is the kernel (`ppid === 0`); see [Capabilities](#capabilities).
- `captureStdout` / `captureStderr` — resolve `SpawnResult.stdout` / `.stderr`
  to the captured bytes. Capture is bounded by `limits.maxOutputBytes`
  (default 64 MiB); overflow truncates, resolves the promise, and SIGKILLs the
  guest so it cannot keep driving host allocations.
- `stdin` / `stdout` / `stderr` (`MessagePort`) — dup2-style fd injection. An
  injected port is transferred straight to the guest (the zero-hop pipeline
  peer owns the other end); the kernel does not retain a read end, so an
  injected stream cannot be captured.
- Redirected stdin (`cmd < file` / `cmd <<<` / `cmd <<EOF`) is **pipe-fed**, not
  inline: `process/spawn`'s per-fd actions wire fd 0 to a kernel pipe — an `open`
  action streams a VFS file's bytes (capability-checked against the parent) and a
  `bytes` action streams an in-memory buffer (here-string/here-doc). Both pump in
  64 KiB credit-windowed chunks, then send EOF/close so a stdin-reading child does
  not block on a producer that will never come. (Relay/QuickJS backends are a
  known gap — pipe-fed stdin needs a transferable backend.)
- `limits` — `ProcessLimits` (memory/cpu/timeout/output/children). The kernel
  arms a wall-clock `timeoutMs` watchdog that SIGKILLs an over-time process
  regardless of backend (Worker/iframe do not self-enforce).
- `display` — GUI placement (`hidden` / `inline` / `window` / `fullscreen`)
  threaded through to the runtime; ignored by non-GUI backends.

stdio not injected or captured is drained-and-discarded (a `/dev/null`) so the
guest's writer keeps getting credit and never stalls.

### `runPipeline(stages)`

Runs `cmd1 | cmd2 | … | cmdN` with **zero-hop** data flow: for N stages the
kernel mints N−1 pipes and transfers stage *i*'s stdout write end and stage
*i+1*'s stdin read end as the two ends of one `MessageChannel` directly into the
respective guests — bytes hop guest→guest with no kernel relay in the data path.
All stages run concurrently; the kernel awaits each exit and returns
`exitCodes` in stage order. Only the **last** stage may `captureStdout`; the
**first** stage may have its stdin pipe-fed (a redirect `open`/`bytes` fd action).
On abnormal stage exit the kernel posts EOF on any injected write port so
downstream readers never hang.

```ts
const { pids, exitCodes, lastStdout } = await kernel.runPipeline([
  { code: cmd1 },
  { code: cmd2 },
  { code: cmd3, captureStdout: true },
]);
```

### `wait(pid)` / `kill(pid, signal)`

`wait` resolves with the process's `WaitResult` (`{ pid, status, code }`) and
reaps it. `kill` signals the process; `SIGKILL` tears down the sandbox via the
launcher/runtime and force-exits the pid with code `137`. Other signals are
forwarded to the runtime.

## Syscall dispatch

Every guest syscall is dispatched by `SyscallDispatcher.dispatch(pid, req)` via a
`switch` on the full string label. The `pid` is **kernel-owned** — a guest (or a
relay launcher) cannot forge it — so capability checks always run against the
real caller. Unknown calls return `ENOSYS`. The families:

- **`fs/*`** (21) — `open`, `read`, `write`, `close`, `stat`, `readdir`,
  `mkdir`, `unlink`, `rmdir`, `rename`, `symlink`, `readlink`, `link`, `chmod`,
  `utimes`, `realpath`, `pipe`, and the extended-attribute ops `getxattr`,
  `setxattr`, `listxattr`, `removexattr` (gated by the `fs` capability like
  `chmod`). Path syscalls are routed through `fs` capability checks to the VFS; a
  per-process fd table maps fds → open files. `fs/pipe` mints a `MessageChannel`
  and transfers **both** ends to the guest.
- **`ipc/*`** (3) — `listen`, `accept`, `connect` over named channels, gated by
  the `ipc` capability for the path. `accept` suspends until a peer connects;
  connection `MessagePort`s are transferred to the guest.
- **`net/fetch`** (1) — the only network surface; the guest never holds a
  socket. The request **origin** is checked against the caller's `net`
  capability *before* the `HttpClient` is invoked (an ungranted/unparseable
  origin → `EACCES`). Redirects are followed in-kernel, re-checking the `net`
  cap against every 3xx target; the chain is capped (→ `ELOOP`).
- **`dom/mutate`** (1) — forwards a batch of `DomMutation` records to
  `onDomMutate`; `ENOSYS` if no handler is configured.
- **`process/*`** (8) — `spawn`, `pipeline`, `wait`, `exit`, `getpid`,
  `getppid`, `getcwd`, `chdir`. Guests fork children, build multi-stage
  pipelines, and reap them entirely through syscalls.

### Path safety (`fs/*`)

Capability checks resolve symlinks before checking: a following operation
(`open`/`stat`/`readdir`/`realpath`/…) is gated against the **canonical**
(symlink-resolved) target, while a link-level operation (`symlink`/`readlink`/
`unlink`/`rename`/…) gates against the canonical parent + lexical leaf. This
prevents an in-grant symlink from escaping its prefix. A symlink cycle surfaces
as `ELOOP` rather than silently passing the check.

## Capabilities

The kernel is the **trust boundary**: capability enforcement happens inside the
dispatcher, identically on the transfer and relay paths.

- **Granting** — `spawn` grants the requested capabilities to the new pid.
- **Narrowing** — when a guest spawns a child (`ppid !== 0`), the child's
  capabilities are run through `capabilities.narrow(parentPid, …)`, so a child
  can only ever hold a **subset** of its parent's. A guest cannot widen a
  child's grants. Only kernel-initiated spawns (`ppid === 0`) get exactly what
  they request. `process/pipeline` narrows each stage from the parent the same
  way.
- **`process` cap + `maxChildren`** — `process/spawn` and `process/pipeline`
  require a `process` capability and honor `maxChildren` against the parent's
  **live** child count (a pipeline of N stages counts as N children up-front).
- **Revocation** — on exit the kernel revokes the pid's capabilities, closes its
  fd tables, and releases its pipes.

## Command resolution & exec-from-VFS

`process/spawn` and `process/pipeline` take a command **path**, resolved
Unix-style (RFC 0001 §4.2):

- URLs (containing `://`) and explicit paths (`/…`, `./…`, `../…`) are used
  **directly**.
- A bare **name** (`cat`) resolves first by walking `$PATH` (`env.PATH`,
  `:`-separated) for a matching VFS file; on a miss it falls back to
  `resolveCommand(name, cwd, env)` from `KernelOptions` (the registry — used for
  bootstrap and host-special commands, e.g. `@mithic/coreutils`'
  `createCoreutilsResolver`). `$PATH`→VFS-file wins over the registry, so an
  installed `/usr/bin` utility whose name also appears in the registry resolves
  to its file. An unresolved name yields `ENOENT`.

A resolved **VFS file** is run as an executable (`binfmt`-style; pure helpers in
`exec-resolve.ts`):

- It must have the **execute bit** set (`mode & 0o111`, else `EACCES`); a missing
  file is `ENOENT`.
- Its `security.capability` xattr (a serialized `Capability[]`,
  `decodeCapabilities`) is the file's grant — read at exec, then **narrowed
  against the parent** like any spawn (Linux file-capabilities model;
  default-deny when absent).
- Its leading shebang dispatches: `#!/bin/node` or no shebang → run the
  (shebang-stripped) source as a JS guest; any other interpreter → re-resolve
  that interpreter by the same rules and run `interpreter <file> <args…>`
  (carrying the **interpreter's** xattr caps). The interpreter chain is bounded
  (→ `ELOOP`).

URLs and inline source strings (a non-path, unresolved name) pass through with no
file-borne caps. With no `$PATH` entry and no resolver configured, only
paths/URLs are spawnable.

## GuestLauncher — how a guest actually starts

The kernel builds the boot wiring (control + stdio ports, `ProcessInit`) and
hands it to a launcher; it never starts a guest module itself.

- **`GuestLauncher.launch(runtime, ctx)`** — for **transferable** backends. The
  default `DefaultGuestLauncher` spawns via the runtime when a usable `Worker`
  exists (browser/iframe), and otherwise (Node with no Worker) bootstraps the
  guest in-process by dynamically importing the module — the control plane is
  identical, the guest still talks over the transferred control port.
- **`RelayLauncher.launchRelay(runtime, ctx)`** — required for
  **non-transferable** backends (`capabilities.directPipes === false`, e.g.
  QuickJS). Instead of transferring ports, the kernel keeps every pipe endpoint
  and the launcher drives I/O through `RelayContext` callbacks
  (`writeStdout`/`writeStderr`/`closeStdout`/`closeStderr`/`notifyExit`).

> **Security:** a relay launcher is never given the raw dispatcher or a pid. It
> relays the guest's raw `call`+`args` through `RelayContext.onSyscall`, which
> the kernel routes through its dispatcher with the correct kernel-owned pid —
> so capability checks run in-kernel, identically to the transfer path. A
> launcher can neither forge a pid nor bypass capability gating. Syscalls that
> mint transferables (e.g. `fs/pipe`) cannot cross the relay bridge and return
> `ENOSYS` there (the minted ports are closed to avoid leaks).

## Exports

- `.` — `Kernel`, `DefaultGuestLauncher`; types `KernelOptions`, `SpawnInit`,
  `SpawnResult`, `PipelineStage`, `PipelineResult`, `LaunchContext`,
  `GuestLauncher`, `RelayContext`, `RelayLauncher`, `RelaySyscallResult`;
  `CapabilityManager` + `FsOperation`; `IpcBroker` + `Pipe`; `ProcessManager` +
  `ProcessState` / `ProcessEntry` / `WaitResult` / `WaitStatus`;
  `SyscallDispatcher` + dispatcher option/handler types (`DomMutateHandler`,
  `SpawnChild`, `WaitChild`, `PipelineChild`, `PipelineStageSpec`, …).
- `./display/remote-dom-host` — `RemoteDomHost`, `ALLOWED_TAGS`,
  `ALLOWED_GLOBAL_ATTRIBUTES`, `GuestDomEvent`, `GuestEventCallback`,
  `RemoteDomHostOptions`.
</content>
</invoke>
