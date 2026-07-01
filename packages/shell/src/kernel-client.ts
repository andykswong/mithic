/**
 * The narrow slice of kernel functionality the {@link Executor} depends on.
 *
 * This is an abstraction over `@mithic/kernel`'s `Kernel` so the executor can be
 * unit-tested with a mock and run for real against the kernel. The real
 * `Kernel.spawn` / `Kernel.runPipeline` / `Kernel.wait` satisfy this shape
 * (`runPipeline` is optional so a minimal mock that provides only `spawn` still
 * works — the executor falls back to spawning each stage itself).
 */

/**
 * D8: the shell's fd-0 (stdin) source for an EXTERNAL command, mapped by the
 * KernelClient onto a kernel `fds` action. The kernel pipe-feeds the child's
 * stdin in BOTH cases (credit-windowed, no whole-buffer copy, works on every
 * backend) — the inline `stdinData` blob is gone (RFC 0001 D8).
 *   - `open`  — a `< path` redirect: the kernel streams the VFS file into fd 0.
 *   - `bytes` — a `<<`/`<<<` body (or an inherited piped-stdin string): the
 *               kernel feeds the buffer into fd 0 then closes it (EOF).
 */
export type StdinFdSpec =
  | { action: 'open'; path: string; flags: { read: true } }
  | { action: 'bytes'; data: Uint8Array };

/** Per-stage / per-command spawn parameters, mirroring the kernel's SpawnInit subset. */
export interface SpawnParams {
  /** Guest program code (inline ESM source string) or a module URL. */
  code: string | URL;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  captureStdout?: boolean;
  captureStderr?: boolean;
  /**
   * D8: kernel fd actions. The shell only ever sets `fds[0]` — the stdin source
   * for a `<`/`<<`/`<<<` redirect (or an inherited piped-stdin string). The
   * KernelClient forwards it as the child's fd-0 wiring.
   */
  fds?: Record<number, StdinFdSpec>;
  /** Injected stdio ports for manual pipe wiring (zero-hop dup2). */
  stdin?: MessagePort;
  stdout?: MessagePort;
  stderr?: MessagePort;
  /**
   * A shell-realm live stdin stream for the child's fd 0 (used ONLY by
   * `spawnStream` on a transferable backend): the client mints a kernel pipe,
   * injects the read end as the child's fd 0, and pumps THIS stream into the
   * write end in-realm. NOT serialized (a ReadableStream is not transferable);
   * mutually exclusive with a `fds[0]` redirect source.
   */
  stdinStream?: ReadableStream<Uint8Array>;
}

export interface SpawnHandle {
  pid: number;
  stdout?: Promise<Uint8Array>;
  stderr?: Promise<Uint8Array>;
}

/**
 * A1: a LIVE spawn handle whose stdout is a `ReadableStream<Uint8Array>` rather
 * than a buffered `Promise<Uint8Array>`. The shell pipes the stream into its own
 * stdout so a large/unbounded final stage streams instead of being buffered to
 * completion (which defeats the kernel's credit-windowed back-pressure).
 */
export interface SpawnStreamHandle {
  pid: number;
  /** Live child stdout. Undefined on relay backends (no port transfer). */
  stdout?: ReadableStream<Uint8Array>;
  /**
   * Bug B: the child's BUFFERED stderr (fd 2). The live path streams only
   * stdout, so stderr is captured to bytes and surfaced here for the shell to
   * drain into its own stderr after the child exits. Undefined when a backend
   * cannot capture stderr (then the shell surfaces nothing — no regression).
   */
  stderr?: Promise<Uint8Array>;
}

/** One stage of a pipeline. */
export interface PipelineStageParams {
  code: string | URL;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  captureStdout?: boolean;
  captureStderr?: boolean;
  /**
   * D8: fd-0 stdin source for the FIRST stage (a `<` / `<<` / `<<<` redirect);
   * later stages read the inter-stage pipe. The KernelClient maps it to the
   * stage's fd-0 wiring (open VFS file, or feed a byte buffer).
   */
  fds?: Record<number, StdinFdSpec>;
}

export interface PipelineRunResult {
  pids: number[];
  exitCodes: number[];
  lastStdout?: Promise<Uint8Array>;
  stderr: Array<Promise<Uint8Array> | undefined>;
}

export interface WaitOutcome {
  pid: number;
  code: number;
}

/**
 * A2: a running coproc. The shell holds the two retained pipe ends: `readLine`
 * reads one line from the child's stdout (over the c2s pipe) and `write` sends
 * to the child's stdin (over the s2c pipe). `pid` is the REAL child pid (for
 * `NAME_PID`). The child runs as a background job; `close` tears down the ends.
 */
export interface CoprocHandle {
  pid: number;
  readLine(): Promise<string | undefined>;
  write(s: string): void | Promise<void>;
  close(): void;
}

export interface KernelClient {
  /** Spawn a single guest program. */
  spawn(params: SpawnParams): Promise<SpawnHandle>;
  /**
   * A2: start a coproc. Mints two kernel pipes (c2s, s2c) and spawns `params` as
   * a child whose stdin reads the shell's writes (s2c) and whose stdout the
   * shell reads (c2s) — via port-injecting `process/spawn`
   * (`fds:{0:dup2,1:dup2}` + transferred `portFds`). Returns the live duplex
   * handle. Requires a transferable backend; rejects with `code:'ENOSYS'`
   * otherwise. Absent on minimal mocks.
   */
  spawnCoproc?(params: SpawnParams): Promise<CoprocHandle>;
  /** Whether the backend can transfer MessagePorts (coproc / live-stream gate). */
  transferable?: boolean;
  /**
   * A1: optional live-stream spawn. Spawns a single command whose stdout is a
   * kernel-minted pipe transferred back to the shell as a `ReadableStream`
   * (`process/spawn` with `fds:{1:{action:'pipe'}}`). The real KernelClient
   * provides this on transferable backends; on relay backends it returns a
   * handle with `stdout: undefined` so the caller falls back to buffered spawn.
   * Absent entirely on minimal mocks (the executor then uses {@link spawn}).
   */
  spawnStream?(params: SpawnParams): Promise<SpawnStreamHandle>;
  /** Wait for a process to exit, returning its exit code. */
  wait(pid: number): Promise<WaitOutcome>;
  /**
   * Optional native pipeline runner (the real kernel provides this). When
   * present the executor delegates pipelines to it for zero-hop data flow;
   * otherwise it spawns each stage via {@link spawn}.
   */
  runPipeline?(stages: PipelineStageParams[]): Promise<PipelineRunResult>;
  /**
   * Optional signal delivery (M14). The real `Kernel.kill(pid, signal)` matches
   * this shape; `signal` is a `SIG`-prefixed name (e.g. `'SIGTERM'`). When
   * present, the `kill` builtin delivers the signal to each of the job's pids;
   * otherwise it only updates the shell job table (best-effort).
   */
  kill?(pid: number, signal: string): void;
}

/**
 * A LIVE bidirectional descriptor, opened once and held open across commands —
 * used for `exec N<>path` against a STREAMING target (notably `/dev/tcp/host/port`
 * and `/dev/udp/...`). Unlike the buffered file path (open → buffer → flush on
 * close), a duplex fd must not be eagerly drained to EOF at open time (a socket
 * has no EOF until the peer closes, and the first read depends on a write that
 * has not happened yet — eager-read deadlocks). Writes go to the live fd
 * immediately; `readLine` reads on demand.
 */
export interface DuplexFd {
  /** Write bytes to the live fd now (no buffering). */
  write(s: string): void | Promise<void>;
  /** Read one line (up to and including `\n`, stripped) from the live fd, or `undefined` at EOF. */
  readLine(): Promise<string | undefined>;
  /** Close the underlying fd. */
  close(): void | Promise<void>;
}

/**
 * Minimal VFS client for redirect execution. The executor uses this to open,
 * write, read, and close files when executing redirect operators (>, >>, <).
 *
 * In the real guest, these map to `mithic.syscall('fs/open' | 'fs/write' |
 * 'fs/read' | 'fs/close', ...)`. In unit tests, supply an in-memory mock.
 */
export interface FsClient {
  /**
   * Open (or create) a file. Returns a numeric file descriptor.
   * @param path  Absolute path to the file.
   * @param flags Open flags — at most one of `write`, `append`, `read` is true.
   */
  fsOpen(
    path: string,
    flags: {
      read?: boolean;
      write?: boolean;
      append?: boolean;
      create?: boolean;
      truncate?: boolean;
    },
  ): number;

  /** Write a string to an open fd. */
  fsWrite(fd: number, data: string): void;

  /** Read the entire contents of an open fd as a string. */
  fsRead(fd: number): string | Promise<string>;

  /** Flush and close an open fd. */
  fsClose(fd: number): void;

  /** List directory entries (names only). Optional — enables glob expansion. */
  fsReaddir?(path: string): string[] | Promise<string[]>;

  /** Stat a path. Optional — enables `[[ -f ]]`/`-d` and glob directory descent. */
  fsStat?(path: string): { dir: boolean } | undefined | Promise<{ dir: boolean } | undefined>;

  /**
   * Open a LIVE bidirectional descriptor for `exec N<>path` (see {@link DuplexFd}).
   * Optional — when present, the executor uses it for `<>` redirects so a
   * STREAMING target (e.g. `/dev/tcp/host/port`) round-trips: the fd is held open
   * across `echo >&N` / `read -u N` instead of being buffered + re-opened per op.
   * When absent, `<>` falls back to the buffered file path (regular files only).
   * May reject (e.g. connection refused, capability denied) — the executor maps a
   * rejection to a non-zero `exec` status.
   */
  fsOpenDuplex?(path: string): DuplexFd | Promise<DuplexFd>;
}
