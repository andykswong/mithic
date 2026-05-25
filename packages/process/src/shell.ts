/**
 * Shell interface for @mithic/process.
 * Higher-level abstraction — not part of the WIT interface.
 */

import type { Process } from './types.ts';
import type { ExecResult, SpawnOptions } from './types.ts';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeout?: number;
}

/**
 * Shell interface — any bash-like interpreter can implement this.
 */
export interface Shell {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  spawn(command: string, args: string[], options?: SpawnOptions): Process;
  setCwd(path: string): void;
  getCwd(): string;
  setEnv(env: Record<string, string>): void;
  getEnv(): Record<string, string>;
  registerCommand(name: string, handler: (args: string[], ctx: unknown) => Promise<{ exitCode: number }>): void;
}
