/**
 * SimpleProcessManager — a basic in-process implementation of ProcessManager.
 * Uses a ProcessTable, CommandResolver, and in-memory pipe-based I/O.
 * Consumers may provide their own ProcessManager without using this.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '@mithic/wasip2/io/streams';
import { Process, ProcessError, type SpawnOptions, type ProcessHandler, type Signal, type ProcessManager, SIGNAL_NUMBER } from '../types.ts';
import { createPipe as createPipeImpl } from '../utils.ts';
import type { PipeOptions } from '../types.ts';

export interface ProcessEntry {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startTime: Date;
  process: Process;
}

export class ProcessTable {
  #nextPid = 1;
  #processes = new Map<number, ProcessEntry>();

  allocPid(): number { return this.#nextPid++; }
  register(pid: number, entry: ProcessEntry): void { this.#processes.set(pid, entry); }
  get(pid: number): ProcessEntry | undefined { return this.#processes.get(pid); }
  remove(pid: number): boolean { return this.#processes.delete(pid); }
  list(): ProcessEntry[] { return [...this.#processes.values()]; }
  get size(): number { return this.#processes.size; }
}

/**
 * A command handler receives pre-wired streams and runs to completion.
 * Returns the exit code.
 */
export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<number>;

export interface CommandContext {
  cwd: string;
  env: Record<string, string>;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
}

export type CommandResolver = (file: string) => CommandHandler | undefined;

/** Default host streams (terminal/null). */
export interface HostStreams {
  stdin: InputStreamHandler;
  stdout: OutputStreamHandler;
  stderr: OutputStreamHandler;
}

const NULL_INPUT: InputStreamHandler = {
  read() { return undefined; },
  blockingRead() { throw { tag: 'closed' }; },
};

const NULL_OUTPUT: OutputStreamHandler = {
  write() {},
  checkWrite() { return 1_000_000; },
};

const DEFAULT_HOST_STREAMS: HostStreams = {
  stdin: NULL_INPUT,
  stdout: NULL_OUTPUT,
  stderr: NULL_OUTPUT,
};

export interface SimpleProcessManagerConfig {
  commandResolver?: CommandResolver;
  processTable?: ProcessTable;
  hostStreams?: HostStreams;
}

/**
 * A simple, in-process ProcessManager implementation.
 * Commands run as async JS functions within the same runtime.
 */
export class SimpleProcessManager implements ProcessManager {
  readonly table: ProcessTable;
  #resolver: CommandResolver;
  readonly #hostStreams: HostStreams;

  constructor(config?: SimpleProcessManagerConfig) {
    this.table = config?.processTable ?? new ProcessTable();
    this.#resolver = config?.commandResolver ?? (() => undefined);
    this.#hostStreams = config?.hostStreams ?? DEFAULT_HOST_STREAMS;
  }

  /** Get the current command resolver. */
  get commandResolver(): CommandResolver { return this.#resolver; }

  /** Set a new command resolver. */
  set commandResolver(resolver: CommandResolver) { this.#resolver = resolver; }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const handler = this.#resolver(file);
    if (!handler) {
      throw new ProcessError('not-found', `command not found: ${file}`);
    }

    const pid = this.table.allocPid();
    const cwd = options?.cwd ?? '/';
    const env = options?.env ?? {};

    const childStdin = options?.stdin ?? new InputStream(this.#hostStreams.stdin);
    const childStdout = options?.stdout ?? new OutputStream(this.#hostStreams.stdout);
    const childStderr = options?.stderr ?? new OutputStream(this.#hostStreams.stderr);

    let killed = false;
    let done = false;
    let exitCode: number | undefined;
    let resolveWait: ((exitCode: number) => void) | null = null;
    const waitPromise = new Promise<number>(r => { resolveWait = r; });

    const processHandler: ProcessHandler = {
      onKill(signal: Signal) {
        if (signal === 'signull') {
          if (done || killed) throw new ProcessError('not-found', 'no such process');
          return;
        }
        killed = true;
        const sigNum = SIGNAL_NUMBER[signal];
        exitCode = 128 + sigNum;
        resolveWait?.(exitCode);
      },
      wait() { return waitPromise; },
      tryWait() { return exitCode; },
    };

    const proc = new Process(pid, processHandler);
    this.table.register(pid, { pid, command: file, args, cwd, startTime: new Date(), process: proc });

    const ctx: CommandContext = {
      cwd,
      env,
      stdin: childStdin,
      stdout: childStdout,
      stderr: childStderr,
    };

    handler(args, ctx).then(
      (code) => {
        done = true;
        if (!killed) {
          exitCode = code;
          resolveWait?.(exitCode);
          this.table.remove(pid);
        }
      },
      (err) => {
        done = true;
        if (!killed) {
          try {
            const msg = new TextEncoder().encode(String(err));
            childStderr.write(msg);
          } catch { /* stderr may be closed */ }
          exitCode = 1;
          resolveWait?.(exitCode);
          this.table.remove(pid);
        }
      },
    );

    return proc;
  }

  createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream } {
    return createPipeImpl(options);
  }

  dupOutputStream(stream: OutputStream): OutputStream {
    return stream.dup();
  }
}
