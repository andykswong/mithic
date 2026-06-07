import { Process, ProcessError, type ProcessManager, type ProcessWorker, type RunOptions, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createExitSlot, createSignalSlot, exitSlotFromBuffer, signalSlotFromBuffer } from '../io/slots.ts';
import { createSharedPipeRaw, inputFromSharedBuffer, outputFromSharedBuffer, type SharedPipeHandle } from '../io/pipes.ts';
import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

interface ProcessEntry {
  pid: number;
  processWorker: ProcessWorker;
  exitSlot: ReturnType<typeof createExitSlot>;
  signalSlot: ReturnType<typeof createSignalSlot>;
}

export interface SpawnExternalOptions extends SpawnOptions {
  /** Pre-created exit slot buffer (SharedArrayBuffer). If provided, used instead of creating a new one. */
  exitSlotBuf?: SharedArrayBuffer;
  /** Pre-created signal slot buffer (SharedArrayBuffer). If provided, used instead of creating a new one. */
  signalSlotBuf?: SharedArrayBuffer;
}

export interface WorkerProcessManagerConfig {
  createWorker: (file: string, name?: string) => ProcessWorker | undefined;
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
  readonly #createWorker: (file: string, name?: string) => ProcessWorker | undefined;
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
    this.#createWorker = config.createWorker;
    this.#maxWorkers = config.maxWorkers ?? 8;
    this.#pipeBufferSize = config.pipeBufferSize ?? 65536;
    this.#createIoPort = config.createIoPort;
    this.#createSpawnPort = config.createSpawnPort;
    this.#isattyStdin = config.isattyStdin ?? false;
    this.#isattyStdout = config.isattyStdout ?? false;
    this.#isattyStderr = config.isattyStderr ?? false;
  }

  spawn(file: string, args: string[], options?: SpawnExternalOptions): Process {
    if (this.#active.size >= this.#maxWorkers) {
      throw new ProcessError('resource-exhausted', `max processes (${this.#maxWorkers}) reached`);
    }

    const pid = this.#nextPid++;
    const processWorker = this.#createWorker(file, `process-${pid}`);
    if (!processWorker) {
      throw new ProcessError('not-found', `command not found: ${file}`);
    }

    const exitSlot = options?.exitSlotBuf ? exitSlotFromBuffer(options.exitSlotBuf) : createExitSlot();
    const signalSlot = options?.signalSlotBuf ? signalSlotFromBuffer(options.signalSlotBuf) : createSignalSlot();

    // Resolve stdio: use caller-provided pipe SABs if available, else inherit host
    const stdinPipeHandle = options?.stdin && pipeHandleMap.get(options.stdin);
    const stdoutPipeHandle = options?.stdout && pipeHandleMap.get(options.stdout);
    const stderrPipeHandle = options?.stderr && pipeHandleMap.get(options.stderr);

    const stdinHandle = stdinPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);
    const stdoutHandle = stdoutPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);
    const stderrHandle = stderrPipeHandle ?? createSharedPipeRaw(this.#pipeBufferSize);

    const ioPort = this.#createIoPort?.();
    const spawnPort = this.#createSpawnPort?.();
    const transferList: Transferable[] = [];
    if (ioPort) transferList.push(ioPort as unknown as Transferable);
    if (spawnPort) transferList.push(spawnPort as unknown as Transferable);

    const runOptions: RunOptions = {
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
      isattyStdin: options?.stdin ? false : this.#isattyStdin,
      isattyStdout: options?.stdout ? false : this.#isattyStdout,
      isattyStderr: options?.stderr ? false : this.#isattyStderr,
      ioPort,
      spawnPort,
    };

    processWorker.run(runOptions, transferList);

    processWorker.addEventListener('error', () => {
      if (exitSlot.tryWait() === undefined) exitSlot.setExitCode(1);
    });
    processWorker.addEventListener('close', () => {
      if (exitSlot.tryWait() === undefined) exitSlot.setExitCode(137);
      this.#active.delete(pid);
    });

    const entry: ProcessEntry = { pid, processWorker, exitSlot, signalSlot };
    this.#active.set(pid, entry);

    const foreground = this.#foreground;
    const proc = new Process(pid, {
      onKill(signal: Signal) {
        signalSlot.send(SIGNAL_NUMBER[signal]);
        if (signal === 'sigkill') processWorker.terminate();
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
      waitAsync() {
        foreground.add(proc);
        const view = new Int32Array(exitSlot.buffer);
        const code = Atomics.load(view, 0);
        if (code !== -1) {
          foreground.delete(proc);
          return Promise.resolve(code);
        }
        return (Atomics.waitAsync(view, 0, -1) as { value: Promise<string> }).value.then(() => {
          foreground.delete(proc);
          return Atomics.load(view, 0);
        });
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
      entry.processWorker.terminate();
    }
    this.#active.clear();
  }
}
