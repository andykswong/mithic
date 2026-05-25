/**
 * Implements the mithic:process/spawn WIT interface.
 * Provides both a pure function (spawnProcess) and module-level stateful spawn.
 */

import { Process, type SpawnOptions, type ProcessHandler, type ExecResult, type Signal, SIGNAL_NUMBER } from './types.ts';
import { ProcessTable } from './table.ts';
import type { CommandHandler, CommandContext } from './commands.ts';

// Module-level state (for backward-compatible spawn function)
let _processTable = new ProcessTable();
let _commandResolver: CommandResolver | null = null;

export type CommandResolver = (file: string) => CommandHandler | undefined;

/** Set the process table instance. */
export function _setProcessTable(table: ProcessTable): void { _processTable = table; }

/** Set the command resolver for looking up command handlers by name. */
export function _setCommandResolver(resolver: CommandResolver): void { _commandResolver = resolver; }

/** Get the current process table. */
export function _getProcessTable(): ProcessTable { return _processTable; }

/** Concatenate buffered chunks into a single Uint8Array. */
function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array();
  if (buffers.length === 1) return buffers[0]!;
  const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Pure spawn function — takes explicit table and resolver parameters.
 * Used by WASIProcess for closure-based isolation.
 */
export function spawnProcess(
  table: ProcessTable,
  resolver: CommandResolver,
  file: string,
  args: string[],
  options?: SpawnOptions,
): Process {
  const handler = resolver(file);
  if (!handler) {
    throw 'not-found';
  }

  const pid = table.allocPid();
  const cwd = options?.cwd ?? '/';
  const env = options?.env ?? {};

  // Buffers for process I/O:
  // - stdinBuffer: host writes here (via Process.stdin() OutputStream), command reads via ctx.readStdin()
  // - stdoutBuffer: command writes here (via ctx.writeStdout()), host reads via Process.stdout() InputStream
  // - stderrBuffer: command writes here (via ctx.writeStderr()), host reads via Process.stderr() InputStream
  const stdinBuffer: Uint8Array[] = [];
  const stdoutBuffer: Uint8Array[] = [];
  const stderrBuffer: Uint8Array[] = [];

  let killed = false;
  let resolveWait: ((result: ExecResult) => void) | null = null;
  const waitPromise = new Promise<ExecResult>(r => { resolveWait = r; });

  const processHandler: ProcessHandler = {
    stdinHandler: {
      write(data: Uint8Array) {
        stdinBuffer.push(new Uint8Array(data));
      },
      flush() { /* no-op for buffered stdin */ },
    },
    stdoutHandler: {
      read(len: number) {
        if (stdoutBuffer.length === 0) return undefined;
        const chunk = stdoutBuffer.shift()!;
        return chunk.length <= len ? chunk : chunk.slice(0, len);
      },
      blockingRead(len: number) {
        if (stdoutBuffer.length === 0) throw { tag: 'closed' };
        const chunk = stdoutBuffer.shift()!;
        return chunk.length <= len ? chunk : chunk.slice(0, len);
      },
    },
    stderrHandler: {
      read(len: number) {
        if (stderrBuffer.length === 0) return undefined;
        const chunk = stderrBuffer.shift()!;
        return chunk.length <= len ? chunk : chunk.slice(0, len);
      },
      blockingRead(len: number) {
        if (stderrBuffer.length === 0) throw { tag: 'closed' };
        const chunk = stderrBuffer.shift()!;
        return chunk.length <= len ? chunk : chunk.slice(0, len);
      },
    },
    onKill(signal: Signal) {
      killed = true;
      const sigNum = SIGNAL_NUMBER[signal];
      resolveWait?.({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 128 + sigNum });
      table.remove(pid);
    },
    wait() { return waitPromise; },
  };

  const proc = new Process(pid, processHandler);
  table.register(pid, { pid, command: file, args, cwd, startTime: new Date(), process: proc });

  // Create command context with access to the I/O buffers
  const ctx: CommandContext = {
    cwd,
    env,
    readStdin(len: number): Uint8Array | undefined {
      if (stdinBuffer.length === 0) return undefined;
      const chunk = stdinBuffer.shift()!;
      return chunk.length <= len ? chunk : chunk.slice(0, len);
    },
    writeStdout(data: Uint8Array): void {
      stdoutBuffer.push(new Uint8Array(data));
    },
    writeStderr(data: Uint8Array): void {
      stderrBuffer.push(new Uint8Array(data));
    },
  };

  // Run the command handler asynchronously
  handler(args, ctx).then(
    (result) => {
      if (!killed) {
        // Collect any remaining buffered output as the final result
        const stdout = concatBuffers(stdoutBuffer);
        const stderr = concatBuffers(stderrBuffer);
        resolveWait?.({ stdout, stderr, exitCode: result.exitCode });
        table.remove(pid);
      }
    },
    (err) => {
      if (!killed) {
        resolveWait?.({
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(String(err)),
          exitCode: 1,
        });
        table.remove(pid);
      }
    },
  );

  return proc;
}

/**
 * Module-level spawn function — uses module-level state.
 * Matches WIT `spawn.spawn` interface.
 */
export function spawn(
  file: string,
  args: string[],
  options?: SpawnOptions,
): Process {
  return spawnProcess(_processTable, _commandResolver ?? (() => undefined), file, args, options);
}
