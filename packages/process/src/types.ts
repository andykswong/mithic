/**
 * WIT-aligned types for mithic:process@0.2.0.
 * Process resource is lifecycle-only (streams are pre-wired at spawn time).
 */

import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

export type Signal = 'sigterm' | 'sigkill' | 'sigint' | 'sigtstp' | 'sigcont' | 'signull';

export const SIGNAL_NUMBER: Record<Signal, number> = {
  sigterm: 15,
  sigkill: 9,
  sigint: 2,
  sigtstp: 20,
  sigcont: 18,
  signull: 0,
};

export type ErrorCode =
  | 'not-found'
  | 'permission-denied'
  | 'invalid-argument'
  | 'resource-exhausted'
  | 'broken-pipe'
  | string;

export type ProcessErrorTag = 'not-found' | 'permission-denied' | 'invalid-argument' | 'resource-exhausted' | 'broken-pipe';

export type ProcessErrorPayload =
  | { tag: ProcessErrorTag }
  | { tag: 'other'; val: string };

export class ProcessError extends Error {
  readonly payload: ProcessErrorPayload;

  constructor(tag: ProcessErrorTag | 'other', message?: string, val?: string) {
    super(message ?? tag);
    this.name = 'ProcessError';
    this.payload = tag === 'other' ? { tag, val: val ?? message ?? '' } : { tag };
  }
}

export interface ExecResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

export interface PipeOptions {
  /** Use SharedArrayBuffer ring buffer for cross-thread pipes. */
  shared?: boolean;
  /** Buffer capacity in bytes (default: 65536). */
  bufferSize?: number;
}

export interface SpawnOptions {
  /** Capability-based working directory. String is resolved by the host. */
  cwd?: string;
  /** Environment variables. If omitted, inherits parent. */
  env?: Record<string, string>;
  /** Pre-wired stdin for the child. If omitted, inherits host default. */
  stdin?: InputStream;
  /** Pre-wired stdout for the child. If omitted, inherits host default. */
  stdout?: OutputStream;
  /** Pre-wired stderr for the child. If omitted, inherits host default. */
  stderr?: OutputStream;
}

export interface ProcessHandler {
  onKill?(signal: Signal): void;
  wait(): Promise<number>;
  tryWait?(): number | undefined;
}

/**
 * Process resource — lifecycle only.
 * Streams are NOT on the process; they are pre-wired at spawn time.
 */
export class Process {
  readonly #pid: number;
  readonly #handler: ProcessHandler;

  constructor(pid: number, handler: ProcessHandler) {
    this.#pid = pid;
    this.#handler = handler;
  }

  pid(): number {
    return this.#pid;
  }

  wait(): Promise<number> {
    return this.#handler.wait();
  }

  tryWait(): number | undefined {
    return this.#handler.tryWait?.();
  }

  kill(signal: Signal = 'sigterm'): void {
    this.#handler.onKill?.(signal);
  }
}

/**
 * ProcessManager interface — the TypeScript equivalent of mithic:process/manager WIT.
 * Consumers may provide any implementation.
 */
export interface ProcessManager {
  spawn(file: string, args: string[], options?: SpawnOptions): Process;
  createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream };
  dupOutputStream(stream: OutputStream): OutputStream;
}
