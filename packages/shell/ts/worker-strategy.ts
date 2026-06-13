import { IoLoop, createCallHandler, handleBlockingCalls, type CallHandler, type InputStreamHandler, type OutputStreamHandler, type SyncOutputStreamHandler } from '@mithic/io/io';
import type { FileSystemProvider } from '@mithic/io/vfs';
import type { HttpClient, SocketProvider } from '@mithic/io/net';
import { WorkerProcessManager, pipeHandleMap, type SpawnExternalOptions } from '@mithic/process/manager/worker';
import { CALL_SPAWN } from '@mithic/process/manager/proxy';
import type { ProcessWorker } from '@mithic/process/types';
import { inputFromSharedBuffer, outputFromSharedBuffer } from '@mithic/process/io';
import type { ProcessManager } from '@mithic/process/types';

export interface WorkerStrategyConfig {
  fs: FileSystemProvider;
  http?: HttpClient;
  sockets?: SocketProvider;
  stdio?: {
    stdin?: InputStreamHandler;
    stdout?: OutputStreamHandler & SyncOutputStreamHandler;
    stderr?: OutputStreamHandler & SyncOutputStreamHandler;
  };
  isatty?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
  createWorker: (file: string, name?: string) => ProcessWorker | undefined;
  maxWorkers?: number;
}

export function createWorkerStrategy(config: WorkerStrategyConfig): ProcessManager & Disposable {
  const ioLoop = new IoLoop({ onCall: createCallHandler({
    fs: config.fs,
    http: config.http,
    sockets: config.sockets,
    stdin: config.stdio?.stdin,
    stdout: config.stdio?.stdout,
    stderr: config.stdio?.stderr,
  }) });

  const spawnPorts: MessagePort[] = [];

  const workerManager = new WorkerProcessManager({
    createWorker: config.createWorker,
    maxWorkers: config.maxWorkers ?? 8,
    createIoPort: () => ioLoop.addWorker(),
    createSpawnPort: () => {
      const { port1, port2 } = new MessageChannel();
      handleBlockingCalls(spawnHandler, port1);
      spawnPorts.push(port1);
      return port2;
    },
    isattyStdin: config.isatty?.stdin ?? false,
    isattyStdout: config.isatty?.stdout ?? false,
    isattyStderr: config.isatty?.stderr ?? false,
  });

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
      const proc = workerManager.spawn(p.file, p.args, options);
      return { pid: proc.pid() };
    }
    throw new Error(`Unknown call: ${call}`);
  };

  return {
    spawn: (file, args, options) => workerManager.spawn(file, args, options),
    createPipe: () => workerManager.createPipe(),
    dupOutputStream: (stream) => stream.dup(),
    signal: (sig) => workerManager.signal(sig),
    get hasForeground() { return workerManager.hasForeground; },
    [Symbol.dispose]() {
      workerManager[Symbol.dispose]();
      for (const port of spawnPorts) port.close();
      spawnPorts.length = 0;
      ioLoop.dispose();
    },
  };
}
