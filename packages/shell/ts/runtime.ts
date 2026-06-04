import { IoLoop, createCallHandler, handleBlockingCalls, type CallHandler, type InputStreamHandler, type OutputStreamHandler, type SyncOutputStreamHandler } from '@mithic/io/io';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { WorkerProcessManager, pipeHandleMap, type SpawnExternalOptions } from '@mithic/process/manager/worker';
import { CALL_SPAWN } from '@mithic/process/manager/proxy';
import type { Process, ProcessWorker } from '@mithic/process/types';
import { inputFromSharedBuffer, outputFromSharedBuffer } from '@mithic/process/io';

export interface RuntimeConfig {
  fs: FileSystemProvider;
  stdio?: {
    stdin?: InputStreamHandler;
    stdout?: OutputStreamHandler & SyncOutputStreamHandler;
    stderr?: OutputStreamHandler & SyncOutputStreamHandler;
  };
  isatty?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
  env?: Record<string, string>;
  cwd?: string;
  createWorker: (file: string, name?: string) => ProcessWorker | undefined;
  maxWorkers?: number;
}

export interface ExecOptions {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class Runtime implements Disposable {
  readonly #ioLoop: IoLoop;
  readonly #workerManager: WorkerProcessManager;
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  readonly #spawnPorts: MessagePort[] = [];

  constructor(config: RuntimeConfig) {
    this.#ioLoop = new IoLoop({ onCall: createCallHandler({
      fs: config.fs,
      stdin: config.stdio?.stdin,
      stdout: config.stdio?.stdout,
      stderr: config.stdio?.stderr,
    }) });

    const spawnHandler: CallHandler = async (call, _id, payload) => {
      if (call === CALL_SPAWN) {
        const p = payload as {
          file: string; args: string[];
          env?: Record<string, string>; cwd?: string;
          exitSlotBuf?: SharedArrayBuffer; signalSlotBuf?: SharedArrayBuffer;
          stdinBuf?: SharedArrayBuffer; stdinBufSize?: number;
          stdoutBuf?: SharedArrayBuffer; stdoutBufSize?: number;
          stderrBuf?: SharedArrayBuffer; stderrBufSize?: number;
        };
        const options: SpawnExternalOptions = {
          env: p.env, cwd: p.cwd,
          exitSlotBuf: p.exitSlotBuf, signalSlotBuf: p.signalSlotBuf,
        };
        if (p.stdinBuf && p.stdinBufSize) {
          const input = inputFromSharedBuffer(p.stdinBuf, p.stdinBufSize);
          pipeHandleMap.set(input, { buffer: p.stdinBuf, bufferSize: p.stdinBufSize });
          options.stdin = input;
        }
        if (p.stdoutBuf && p.stdoutBufSize) {
          const output = outputFromSharedBuffer(p.stdoutBuf, p.stdoutBufSize);
          pipeHandleMap.set(output, { buffer: p.stdoutBuf, bufferSize: p.stdoutBufSize });
          options.stdout = output;
        }
        if (p.stderrBuf && p.stderrBufSize) {
          const stderr = outputFromSharedBuffer(p.stderrBuf, p.stderrBufSize);
          pipeHandleMap.set(stderr, { buffer: p.stderrBuf, bufferSize: p.stderrBufSize });
          options.stderr = stderr;
        }
        const proc = this.#workerManager.spawn(p.file, p.args, options);
        return { pid: proc.pid() };
      }
      throw new Error(`Unknown call: ${call}`);
    };

    this.#workerManager = new WorkerProcessManager({
      createWorker: config.createWorker,
      maxWorkers: config.maxWorkers ?? 8,
      createIoPort: () => this.#ioLoop.addWorker(),
      createSpawnPort: () => {
        const { port1, port2 } = new MessageChannel();
        handleBlockingCalls(spawnHandler, port1);
        this.#spawnPorts.push(port1);
        return port2;
      },
      isattyStdin: config.isatty?.stdin ?? false,
      isattyStdout: config.isatty?.stdout ?? false,
      isattyStderr: config.isatty?.stderr ?? false,
    });

    this.#env = config.env ?? {};
    this.#cwd = config.cwd ?? '/';
  }

  get ioLoop(): IoLoop { return this.#ioLoop; }
  get workerManager(): WorkerProcessManager { return this.#workerManager; }

  exec(command: string, options?: ExecOptions): Process {
    const args = options?.args ?? [];
    return this.#workerManager.spawn(command, args, {
      env: { ...this.#env, ...options?.env },
      cwd: options?.cwd ?? this.#cwd,
    });
  }

  waitAsync(proc: Process): Promise<number> {
    return new Promise((resolve) => {
      const poll = () => {
        const code = proc.tryWait();
        if (code !== undefined) resolve(code);
        else setTimeout(poll, 1);
      };
      poll();
    });
  }

  [Symbol.dispose](): void {
    this.#workerManager[Symbol.dispose]();
    for (const port of this.#spawnPorts) port.close();
    this.#spawnPorts.length = 0;
    this.#ioLoop.dispose();
  }
}
