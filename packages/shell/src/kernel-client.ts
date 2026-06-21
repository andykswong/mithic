/**
 * The narrow slice of kernel functionality the {@link Executor} depends on.
 *
 * This is an abstraction over `@mithic/kernel`'s `Kernel` so the executor can be
 * unit-tested with a mock and run for real against the kernel. The real
 * `Kernel.spawn` / `Kernel.runPipeline` / `Kernel.wait` satisfy this shape
 * (`runPipeline` is optional so a minimal mock that provides only `spawn` still
 * works — the executor falls back to spawning each stage itself).
 */

/** Per-stage / per-command spawn parameters, mirroring the kernel's SpawnInit subset. */
export interface SpawnParams {
  /** Guest program code (inline ESM source string) or a module URL. */
  code: string | URL;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  captureStdout?: boolean;
  captureStderr?: boolean;
  /** Inline stdin contents to feed the child (e.g. from a `<` redirect). */
  stdinData?: string;
  /** Injected stdio ports for manual pipe wiring (zero-hop dup2). */
  stdin?: MessagePort;
  stdout?: MessagePort;
  stderr?: MessagePort;
}

export interface SpawnHandle {
  pid: number;
  stdout?: Promise<Uint8Array>;
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
  /** Inline stdin for the FIRST stage (a `<` / `<<` / `<<<` redirect source). */
  stdinData?: string;
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

export interface KernelClient {
  /** Spawn a single guest program. */
  spawn(params: SpawnParams): Promise<SpawnHandle>;
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
