import type { WorkerFactory, ManagedWorker } from '@mithic/io/io/worker-factory';
import { Process, ProcessError, type ProcessManager, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createExitSlot, createSignalSlot } from './slots.ts';
import { createPipe, createSharedPipeRaw } from '../utils.ts';
import type { CommandRegistry } from './component-registry.ts';
import type { CompileResult } from './compiler-bridge.ts';
import type { RunMessage } from './process-worker.ts';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

interface ProcessEntry {
  pid: number;
  worker: ManagedWorker;
  exitSlot: ReturnType<typeof createExitSlot>;
  signalSlot: ReturnType<typeof createSignalSlot>;
}

export interface WorkerProcessManagerConfig {
  registry: CommandRegistry;
  workerFactory: WorkerFactory;
  processWorkerUrl: string | URL;
  maxWorkers?: number;
  pipeBufferSize?: number;
}

export class WorkerProcessManager implements ProcessManager, Disposable {
  readonly #registry: CommandRegistry;
  readonly #factory: WorkerFactory;
  readonly #processWorkerUrl: string | URL;
  readonly #maxWorkers: number;
  readonly #pipeBufferSize: number;
  readonly #active = new Map<number, ProcessEntry>();
  readonly #foreground = new Set<Process>();
  #nextPid = 1;

  constructor(config: WorkerProcessManagerConfig) {
    this.#registry = config.registry;
    this.#factory = config.workerFactory;
    this.#processWorkerUrl = config.processWorkerUrl;
    this.#maxWorkers = config.maxWorkers ?? 8;
    this.#pipeBufferSize = config.pipeBufferSize ?? 65536;
  }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const precompiled = this.#registry.resolvePrecompiled(file);
    if (!precompiled) {
      throw new ProcessError('not-found', `command not found: ${file}`);
    }

    if (this.#active.size >= this.#maxWorkers) {
      throw new ProcessError('resource-exhausted', `max processes (${this.#maxWorkers}) reached`);
    }

    const pid = this.#nextPid++;
    const exitSlot = createExitSlot();
    const signalSlot = createSignalSlot();

    const stdinPipe = createSharedPipeRaw(this.#pipeBufferSize);
    const stdoutPipe = createSharedPipeRaw(this.#pipeBufferSize);
    const stderrPipe = createSharedPipeRaw(this.#pipeBufferSize);

    const worker = this.#factory.create(this.#processWorkerUrl, { name: `process-${pid}` });

    const msg: RunMessage = {
      type: 'run',
      compileResult: { modules: {}, jsFiles: {}, cached: false },
      args: [file, ...args],
      env: options?.env ?? {},
      cwd: options?.cwd ?? '/',
      exitSlotBuf: exitSlot.buffer,
      signalSlotBuf: signalSlot.buffer,
      stdinBuf: stdinPipe.buffer,
      stdinBufSize: stdinPipe.bufferSize,
      stdoutBuf: stdoutPipe.buffer,
      stdoutBufSize: stdoutPipe.bufferSize,
      stderrBuf: stderrPipe.buffer,
      stderrBufSize: stderrPipe.bufferSize,
    };

    worker.postMessage(msg);

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
    return createPipe({ ...options, shared: true, bufferSize: options?.bufferSize ?? this.#pipeBufferSize });
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
