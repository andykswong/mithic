# @mithic/protocol

Wire-protocol types shared across the Mithic runtime. This package is pure type,
constant, and guard definitions — the single source of truth for the messages
that flow between the kernel, a runtime backend, and a sandboxed guest. It has
**zero dependencies**: every other Mithic package builds on top of it.

The kernel and guest never hand-roll these shapes — import the types, constants,
and guards from here so both sides stay compatible.

## What's in it

Everything is re-exported from the single entry point (`@mithic/protocol`), which
aggregates the source modules below.

### Process & capabilities (`process.ts`)

The shape a runtime hands a guest at boot, plus the capability and resource-limit
model.

- **`ProcessInit`** — the boot message: `entry` (`string | URL`), `args`, `env`,
  `cwd`, `pid`/`ppid` (+ optional `uid`), `capabilities`, optional `limits`, and
  optional `preopens` (fd-numbered `PreopenDescriptor`s).
- **`Capability`** — discriminated union (on `type`) gating what a process may
  touch: `fs` (`paths` + `operations: ('read'|'write'|'execute')[]`),
  `net` (`origins`), `ipc` (`channels`), `process` (optional `maxChildren`),
  and `env`.
- **`ProcessLimits`** — `memoryMb`, `cpuMs`, `timeoutMs`, `maxOutputBytes`,
  `maxChildren`, `networkDisabled` (all optional; enforced by backends that
  advertise the matching capability).
- **`ProcessReady` / `ProcessExit`** — guest lifecycle messages, with guards
  `isProcessReady` and `isProcessExit`.
- **Spawn** — `SpawnArgs` (`path`, `argv`, optional `env`/`cwd`/`fds`),
  `SpawnResult` (`pid` + optional transferred-pipe map), `FdAction`
  (`inherit | pipe | open | bytes | close | dup2`), and `DEFAULT_FD_ACTIONS`
  (fds 0/1/2 → `inherit`). There is no inline `stdinData`: a redirect feeds
  stdin (`fds[0]`) through a kernel pipe via the `open` (`< file`, streamed) or
  `bytes` (`<<`/`<<<` body, credit-windowed) action.
- **Descriptors** — `OFlags`, `FdRights`, `FdFlags`, and `PreopenDescriptor`.

### Syscall messages (`messages.ts`)

The request/response envelope for the kernel syscall channel, plus kernel-pushed
events.

- **`SyscallRequest`** — `{ id, call, args }`; build one with `makeSyscallRequest`.
- **`SyscallResponse`** — ok/err union: `{ id, ok: true, result }` or
  `{ id, ok: false, error: { code: ErrnoCode, message } }`. Guard:
  `isSyscallResponse`.
- **`KernelEvent`** — unsolicited kernel → guest events `{ event, payload? }`
  (e.g. signal delivery, DOM events). Guard: `isKernelEvent` (distinguishes an
  event from a response by the absence of `id`).
- **`PROGRESS_EVENT`** / **`ProgressPayload`** — the well-known `KernelEvent.event`
  name (`'progress'`) and its typed payload (`fraction` in `[0, 1]`, optional
  `message`) for a long-running guest's progress updates. `KernelEvent` stays
  open-ended; this is one typed variant, not a closed union.

### Errno & signals (`errno.ts`)

- **`ERRNO_CODES`** — the 26 POSIX errno strings used throughout
  (`EACCES`, `EBADF`, `EBUSY`, `EEXIST`, `EFAULT`, `EINVAL`, `EIO`, `EISDIR`,
  `EMFILE`, `ENAMETOOLONG`, `ENOENT`, `ENOSPC`, `ENOTDIR`, `ENOTEMPTY`, `EPERM`,
  `EPIPE`, `ESRCH`, `ETIMEDOUT`, `EXDEV`, `EAGAIN`, `ENOSYS`, `ELOOP`, `EROFS`,
  `EHOSTUNREACH`, `ECONNREFUSED`, `ENETUNREACH`). Type `ErrnoCode`; guard
  `isErrnoCode`.
- **`SIGNALS`** — `SIGTERM`, `SIGINT`, `SIGKILL`, `SIGSTOP`, `SIGCONT`,
  `SIGPIPE`, `SIGCHLD`, `SIGUSR1`, `SIGUSR2`. Type `Signal`.

### Filesystem errno mapping (`fs-errno.ts`)

Translates `@mithic/io`'s WASI-style `FileSystemError` codes into POSIX errno for
syscall responses.

- **`FileSystemErrorCode`** — the source code set (`access`, `exist`, `no-entry`,
  `not-directory`, `is-directory`, `not-empty`, `invalid`, `insufficient-space`,
  `io`, `loop`, `name-too-long`, `not-permitted`, `read-only`, `cross-device`,
  `unsupported`).
- **`FS_ERROR_TO_ERRNO`** — the static map (e.g. `no-entry → ENOENT`,
  `read-only → EROFS`, `unsupported → ENOSYS`).
- **`fsErrorToErrno(code)`** — lookup helper, defaulting unknown codes to `EIO`.

### Pipe protocol (`pipe.ts`)

The credit-based, flow-controlled message protocol for IPC pipes between
processes.

- **`PipeMessage`** — union of `data` (`{ chunk: Uint8Array }`), `end`,
  `error` (`{ code: 'EPIPE' }`), and `credit` (`{ bytes }`). Guard:
  `isPipeMessage`.
- **Tuning constants** — `TRANSFER_THRESHOLD_BYTES` (10 KiB, above which chunks
  are transferred rather than copied), `PIPE_FLUSH_BYTES` (16 KiB),
  `PIPE_FLUSH_MS` (4 ms), and `INITIAL_CREDIT_BYTES` (64 KiB starting flow-control
  window).

### Extended attributes & file capabilities (`xattr.ts`)

The wire constant + codec for storing a capability grant as an `xattr` on an
executable (the Linux file-capabilities model: `exec` reads the grant and narrows
it against the parent).

- **`SECURITY_CAPABILITY_XATTR`** — the well-known xattr name (`security.capability`)
  whose value is a serialized `Capability[]` granting the executable's caps.
- **`encodeCapabilities(caps)`** / **`decodeCapabilities(bytes)`** — JSON codec for
  that value. `decodeCapabilities` is **default-deny**: undefined, unparseable, or
  any malformed element rejects the whole array (no partially-trusted grant).

The matching syscalls — `fs/getxattr`, `fs/setxattr`, `fs/listxattr`,
`fs/removexattr` (in the `Syscall` union of `syscall.ts`, capability-gated like
`fs/chmod`) — read and write these attributes through the VFS.

## Quick start

```ts
import { isSyscallResponse, type Capability, type ProcessInit } from '@mithic/protocol';

const caps: Capability[] = [
  { type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] },
  { type: 'net', origins: ['https://api.example.com'] },
];

function handle(msg: unknown) {
  if (isSyscallResponse(msg) && msg.ok) {
    // msg.result is the syscall return value
  }
}
```
