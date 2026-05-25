/**
 * WIT-aligned types for @mithic/process.
 * Contains the Process resource class and related types.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '@mithic/wasip2/io/streams';

export type Signal = 'sigterm' | 'sigkill' | 'sigint' | 'signull';

export const SIGNAL_NUMBER: Record<Signal, number> = {
  sigterm: 15,
  sigkill: 9,
  sigint: 2,
  signull: 0,
};

export type ErrorCode = 'not-found' | 'permission-denied' | 'invalid-argument' | 'resource-exhausted' | string;

export interface ExecResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessHandler {
  /** Handler for stdin (host writes to process stdin via OutputStream). */
  stdinHandler: OutputStreamHandler;
  /** Handler for stdout (host reads from process stdout via InputStream). */
  stdoutHandler: InputStreamHandler;
  /** Handler for stderr (host reads from process stderr via InputStream). */
  stderrHandler: InputStreamHandler;
  /** Called when kill signal is sent. */
  onKill?(signal: Signal): void;
  /** Called to wait for process exit. */
  wait(): Promise<ExecResult>;
}

/**
 * Process resource class — wraps a ProcessHandler.
 * Similar to InputStream/OutputStream wrapping handlers in wasip2.
 */
export class Process {
  readonly pid: number;
  readonly #handler: ProcessHandler;
  readonly #stdin: OutputStream;
  readonly #stdout: InputStream;
  readonly #stderr: InputStream;

  constructor(pid: number, handler: ProcessHandler) {
    this.pid = pid;
    this.#handler = handler;
    this.#stdin = new OutputStream(handler.stdinHandler);
    this.#stdout = new InputStream(handler.stdoutHandler);
    this.#stderr = new InputStream(handler.stderrHandler);
  }

  /** Get the stdin stream for writing to the process. */
  stdin(): OutputStream { return this.#stdin; }

  /** Get the stdout stream for reading from the process. */
  stdout(): InputStream { return this.#stdout; }

  /** Get the stderr stream for reading from the process. */
  stderr(): InputStream { return this.#stderr; }

  /** Wait for the process to exit. */
  wait(): Promise<ExecResult> {
    return this.#handler.wait();
  }

  /** Send a signal to the process. */
  kill(signal: Signal = 'sigterm'): void {
    this.#handler.onKill?.(signal);
  }
}
