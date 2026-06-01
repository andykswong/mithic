import type { WorkerFactory, ManagedWorker } from '@mithic/io/io/worker-factory';
import { Process, ProcessError, type ProcessManager, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createExitSlot, createSignalSlot, exitSlotFromBuffer, signalSlotFromBuffer } from '../io/slots.ts';
import { createSharedPipeRaw, inputFromSharedBuffer, outputFromSharedBuffer, type SharedPipeHandle } from '../io/pipes.ts';
import type { CompileResult } from '../component/compiler.ts';
import type { RunMessage } from '../worker/process.ts';
import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

interface ProcessEntry {
  pid: number;
  worker: ManagedWorker;
  exitSlot: ReturnType<typeof createExitSlot>;
  signalSlot: ReturnType<typeof createSignalSlot>;
}

export interface SpawnExternalOptions extends SpawnOptions {
  /** Pre-created exit slot buffer (SharedArrayBuffer). If provided, used instead of creating a new one. */
  exitSlotBuf?: SharedArrayBuffer;
  /** Pre-created signal slot buffer (SharedArrayBuffer). If provided, used instead of creating a new one. */
  signalSlotBuf?: SharedArrayBuffer;
}

export type CommandResolver = (file: string) => CompileResult | undefined;

export interface WorkerProcessManagerConfig {
  resolveCommand: CommandResolver;
  workerFactory: WorkerFactory;
  processWorkerUrl: string | URL;
  maxWorkers?: number;
  pipeBufferSize?: number;
  createIoPort?: () => MessagePort;
  createSpawnPort?: () => MessagePort;
  isattyStdin?: boolean;
  isattyStdout?: boolean;
  isattyStderr?: boolean;
}

export const pipeHandleMap = new WeakMap<object, SharedPipeHandle>();

export class WorkerProcessManager implements ProcessManager, Disposable {
  readonly #resolveCommand: CommandResolver;
  readonly #factory: WorkerFactory;
  readonly #processWorkerUrl: string | URL;
  readonly #maxWorkers: number;
  readonly #pipeBufferSize: number;
  readonly #createIoPort?: () => MessagePort;
  readonly #createSpawnPort?: () => MessagePort;
  readonly #isattyStdin: boolean = false;
  readonly #isattyStdout: boolean = false;
  readonly #isattyStderr: boolean = false;
  readonly #active = new Map<number, ProcessEntry>();
  readonly #foreground = new Set<Process>();
  #nextPid = 1;

  constructor(config: WorkerProcessManagerConfig) {
    this.#resolveCommand = config.resolveCommand;
    this.#factory = config.workerFactory;
    this.#processWorkerUrl = config.processWorkerUrl;
    this.#maxWorkers = config.maxWorkers ?? 8;
    this.#pipeBufferSize = config.pipeBufferSize ?? 65536;
    this.#createIoPort = config.createIoPort;
    this.#createSpawnPort = config.createSpawnPort;
    this.#isattyStdin = config.isattyStdin ?? false;
    this.#isattyStdout = config.isattyStdout ?? false;
    this.#isattyStderr = config.isattyStderr ?? false;
  }

  spawn(file: string, args: string[], options?: SpawnExternalOptions): Process {
    const compileResult = this.#resolveCommand(file);
    if (!compileResult) {
      throw new ProcessError('not-found', `command not found: ${file}`);
    }

    if (this.#active.size >= this.#maxWorkers) {
      throw new ProcessError('resource-exhausted', `max processes (${this.#maxWorkers}) reached`);
    }

    const pid = this.#nextPid++;
    const exitSlot = options?.exitSlotBuf ? exitSlotFromBuffer(options.exitSlotBuf) : createExitSlot();
    const signalSlot = options?.signalSlotBuf ? signalSlotFromBuffer(options.signalSlotBuf) : createSignalSlot();

    // Resolve stdio: use caller-provided pipe SABs if available, else inherit host
    const stdinPipeHandle = options?.stdin && pipeHandleMap.get(options.stdin);
    const stdoutPipeHandle = options?.stdout && pipeHandleMap.get(options.stdout);
    const stderrPipeHandle = options?.stderr && pipeHandleMap.get(options.stderr);

    const stdinHandle = stdinPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);
    const stdoutHandle = stdoutPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);
    const stderrHandle = stderrPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);

    const worker = this.#factory.create(this.#processWorkerUrl, { name: `process-${pid}` });

    const ioPort = this.#createIoPort?.();
    const spawnPort = this.#createSpawnPort?.();
    const transferList: Transferable[] = [];
    if (ioPort) transferList.push(ioPort as unknown as Transferable);
    if (spawnPort) transferList.push(spawnPort as unknown as Transferable);

    const msg: RunMessage = {
      type: 'run',
      compileResult,
      args: [file, ...args],
      env: options?.env ?? {},
      cwd: options?.cwd ?? '/',
      exitSlotBuf: exitSlot.buffer,
      signalSlotBuf: signalSlot.buffer,
      stdinBuf: stdinHandle.buffer,
      stdinBufSize: stdinHandle.bufferSize,
      stdoutBuf: stdoutHandle.buffer,
      stdoutBufSize: stdoutHandle.bufferSize,
      stderrBuf: stderrHandle.buffer,
      stderrBufSize: stderrHandle.bufferSize,
      inheritStdin: !stdinPipeHandle && !options?.stdin,
      inheritStdout: !stdoutPipeHandle && !options?.stdout,
      inheritStderr: !stderrPipeHandle && !options?.stderr,
      isattyStdin: this.#isattyStdin,
      isattyStdout: this.#isattyStdout,
      isattyStderr: this.#isattyStderr,
      ioPort,
      spawnPort,
    };

    worker.postMessage(msg, transferList);

    worker.on('error', () => {
      if (exitSlot.tryWait() === undefined) exitSlot.setExitCode(1);
    });
    worker.on('exit', () => {
      if (exitSlot.tryWait() === undefined) exitSlot.setExitCode(137);
      this.#active.delete(pid);
    });

    const entry: ProcessEntry = { pid, worker, exitSlot, signalSlot };
    this.#active.set(pid, entry);

    const foreground = this.#foreground;
    const proc = new Process(pid, {
      onKill(signal: Signal) {
        signalSlot.send(SIGNAL_NUMBER[signal]);
        if (signal === 'sigkill') worker.terminate();
      },
      wait() {
        foreground.add(proc);
        try {
          return exitSlot.wait();
        } finally {
          foreground.delete(proc);
        }
      },
      tryWait() {
        return exitSlot.tryWait();
      },
    });

    return proc;
  }

  createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream } {
    const bufferSize = options?.bufferSize ?? this.#pipeBufferSize;
    const handle = createSharedPipeRaw(bufferSize);
    const input = inputFromSharedBuffer(handle.buffer, handle.bufferSize);
    const output = outputFromSharedBuffer(handle.buffer, handle.bufferSize);
    // Associate streams with their backing SAB so spawn() can extract it
    pipeHandleMap.set(input, handle);
    pipeHandleMap.set(output, handle);
    return { input, output };
  }

  dupOutputStream(stream: OutputStream): OutputStream {
    const handle = pipeHandleMap.get(stream);
    const dup = stream.dup();
    if (handle) pipeHandleMap.set(dup, handle);
    return dup;
  }

  signal(sig: Signal): void {
    for (const proc of this.#foreground) {
      proc.kill(sig);
    }
  }

  get hasForeground(): boolean {
    return this.#foreground.size > 0;
  }

  getProcessSlots(pid: number): { exitSlotBuf: SharedArrayBuffer; signalSlotBuf: SharedArrayBuffer } | undefined {
    const entry = this.#active.get(pid);
    if (!entry) return undefined;
    return { exitSlotBuf: entry.exitSlot.buffer, signalSlotBuf: entry.signalSlot.buffer };
  }

  [Symbol.dispose](): void {
    for (const entry of this.#active.values()) {
      if (entry.exitSlot.tryWait() === undefined) {
        entry.exitSlot.setExitCode(129);
      }
      entry.worker.terminate();
    }
    this.#active.clear();
  }
}
