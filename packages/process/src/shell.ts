/**
 * Shell interface for @mithic/process.
 * Any shell implementation (just-bash, Rust WASM shell) implements this contract.
 */

import type { ExecResult, ProcessManager } from './types.ts';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeout?: number;
}

/**
 * Shell interface — a process that orchestrates command execution.
 * Consumes a ProcessManager to spawn child processes and create pipes.
 */
export interface Shell {
  /** The process manager this shell uses to spawn children. */
  readonly manager: ProcessManager;

  /** Execute a command string and return the result. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Get/set the working directory. */
  setCwd(path: string): void;
  getCwd(): string;

  /** Get/set environment variables. */
  setEnv(env: Record<string, string>): void;
  getEnv(): Record<string, string>;
}
