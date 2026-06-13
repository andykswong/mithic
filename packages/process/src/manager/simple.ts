/**
 * SimpleProcessManager — a basic in-process implementation of ProcessManager.
 * Uses a ProcessTable, CommandResolver, and in-memory pipe-based I/O.
 * Consumers may provide their own ProcessManager without using this.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '@mithic/wasip2/io/streams';
import { Process, ProcessError, type SpawnOptions, type ProcessHandler, type Signal, type ProcessManager, SIGNAL_NUMBER } from '../types.ts';
import { createPipe as createPipeImpl } from '../io/pipes.ts';
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
 * Returns the exit code synchronously or via Promise.
 */
export type CommandHandler = (args: string[], ctx: CommandContext) => number | Promise<number>;

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
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
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
  stdin: new InputStream(NULL_INPUT),
  stdout: new OutputStream(NULL_OUTPUT),
  stderr: new OutputStream(NULL_OUTPUT),
};

export interface SimpleProcessManagerConfig {
  commandResolver?: CommandResolver;
  processTable?: ProcessTable;
  hostStreams?: HostStreams;
  /** Default environment variables inherited by spawned processes when no env is given. */
  env?: Record<string, string>;
}

/**
 * A simple, in-process ProcessManager implementation.
 * Commands run as async JS functions within the same runtime.
 */
export class SimpleProcessManager implements ProcessManager {
  readonly table: ProcessTable;
  #resolver: CommandResolver;
  readonly #hostStreams: HostStreams;
  readonly #hostEnv: Record<string, string>;
  readonly #foreground = new Set<Process>();

  constructor(config?: SimpleProcessManagerConfig) {
    this.table = config?.processTable ?? new ProcessTable();
    this.#resolver = config?.commandResolver ?? (() => undefined);
    this.#hostStreams = config?.hostStreams ?? DEFAULT_HOST_STREAMS;
    this.#hostEnv = config?.env ?? {};
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
    const rawEnv = options?.env as unknown;
    const env: Record<string, string> = rawEnv === undefined
      ? this.#hostEnv
      : Array.isArray(rawEnv)
        ? Object.fromEntries(rawEnv as [string, string][])
        : (rawEnv as Record<string, string>);

    const childStdin = options?.stdin ?? this.#hostStreams.stdin.dup();
    const childStdout = options?.stdout ?? this.#hostStreams.stdout.dup();
    const childStderr = options?.stderr ?? this.#hostStreams.stderr.dup();

    let killed = false;
    let done = false;
    let exitCode: number | undefined;
    let exitPromise: Promise<number> | undefined;

    const foreground = this.#foreground;
    const processHandler: ProcessHandler = {
      onKill(signal: Signal) {
        if (signal === 'signull') {
          if (done || killed) throw new ProcessError('not-found', 'no such process');
          return;
        }
        killed = true;
        const sigNum = SIGNAL_NUMBER[signal];
        exitCode = 128 + sigNum;
      },
      wait(): number | Promise<number> {
        foreground.add(proc);
        if (done || killed) {
          foreground.delete(proc);
          return exitCode ?? 0;
        }
        if (exitPromise) {
          return exitPromise.then(code => {
            foreground.delete(proc);
            return code;
          });
        }
        foreground.delete(proc);
        return exitCode ?? 0;
      },
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

    const result = handler([file, ...args], ctx);

    if (typeof result === 'number') {
      done = true;
      exitCode = result;
      this.table.remove(pid);
    } else {
      exitPromise = result.then(
        (code: number) => {
          done = true;
          if (!killed) {
            exitCode = code ?? 0;
          }
          this.table.remove(pid);
          return exitCode ?? 0;
        },
        (err: unknown) => {
          done = true;
          if (!killed) {
            try {
              const msg = new TextEncoder().encode(String(err));
              childStderr.write(msg);
            } catch { /* stderr may be closed */ }
            exitCode = 1;
          }
          this.table.remove(pid);
          return exitCode ?? 0;
        },
      );
    }

    return proc;
  }

  createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream } {
    return createPipeImpl(options);
  }

  dupOutputStream(stream: OutputStream): OutputStream {
    return stream.dup();
  }

  signal(sig: Signal): void {
    for (const proc of this.#foreground) {
      proc.kill(sig);
    }
  }

  get hasForeground(): boolean {
    return this.#foreground.size > 0;
  }
}
