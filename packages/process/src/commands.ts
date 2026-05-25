/**
 * Command handler types for @mithic/process.
 * Command handlers implement the logic for spawned processes.
 */

export interface CommandContext {
  /** Working directory for the command. */
  cwd: string;
  /** Environment variables. */
  env: Record<string, string>;
  /** Read stdin data that the host has written. Returns undefined if no data available. */
  readStdin(len: number): Uint8Array | undefined;
  /** Write data to stdout (host reads via Process.stdout()). */
  writeStdout(data: Uint8Array): void;
  /** Write data to stderr (host reads via Process.stderr()). */
  writeStderr(data: Uint8Array): void;
}

export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<{ exitCode: number }>;
