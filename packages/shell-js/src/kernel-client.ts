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
}

/**
 * Minimal VFS client for redirect execution. The executor uses this to open,
 * write, read, and close files when executing redirect operators (>, >>, <).
 *
 * In the real guest, these map to `isola.syscall('fs/open' | 'fs/write' |
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
  fsRead(fd: number): string;

  /** Flush and close an open fd. */
  fsClose(fd: number): void;
}
