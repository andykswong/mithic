import type { BlockingCallFn } from '@mithic/io/io';
import { Process, type ProcessManager, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createSharedPipeRaw, inputFromSharedBuffer, outputFromSharedBuffer, type SharedPipeHandle } from '../io/pipes.ts';
import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

export const CALL_SPAWN = 10;

interface SpawnResult {
  pid: number;
}

/**
 * ProxyProcessManager — runs in a shell Worker, delegates spawn to the main thread
 * orchestrator via a sync-bridge BlockingCallFn.
 *
 * Pipes are created locally (SharedArrayBuffer-backed) and their SAB handles are sent
 * to the main thread in the spawn request payload (structured clone preserves SABs).
 * Exit/signal slots are also created locally and sent with the spawn request so both
 * threads share the same atomic slots.
 */
export interface ProxyProcessManagerConfig {
  pipeBufferSize?: number;
  hostStdout?: OutputStream;
  hostStderr?: OutputStream;
}

export class ProxyProcessManager implements ProcessManager {
  readonly #bridge: BlockingCallFn;
  readonly #foreground = new Set<Process>();
  readonly #pipeHandles = new WeakMap<object, SharedPipeHandle>();
  readonly #pipeBufferSize: number;
  readonly #hostStdout?: OutputStream;
  readonly #hostStderr?: OutputStream;

  constructor(bridge: BlockingCallFn, options?: ProxyProcessManagerConfig) {
    this.#bridge = bridge;
    this.#pipeBufferSize = options?.pipeBufferSize ?? 65536;
    this.#hostStdout = options?.hostStdout;
    this.#hostStderr = options?.hostStderr;
  }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const stdinHandle = options?.stdin ? this.#pipeHandles.get(options.stdin) : undefined;
    const stdoutHandle = options?.stdout ? this.#pipeHandles.get(options.stdout) : undefined;
    const stderrHandle = options?.stderr ? this.#pipeHandles.get(options.stderr) : undefined;

    // For non-pipe stdin: pump data into a bridge SharedPipe synchronously
    let stdinBridgeHandle: SharedPipeHandle | undefined;
    if (options?.stdin && !stdinHandle) {
      stdinBridgeHandle = createSharedPipeRaw(this.#pipeBufferSize);
      const bridgeOut = outputFromSharedBuffer(stdinBridgeHandle.buffer, stdinBridgeHandle.bufferSize);
      try {
        while (true) {
          const chunk = options.stdin.read(BigInt(this.#pipeBufferSize));
          if (chunk.byteLength === 0) break;
          bridgeOut.write(chunk);
        }
      } catch { /* stream closed */ }
      bridgeOut[Symbol.dispose]();
    }

    // For non-pipe stdout/stderr (including inherited): create bridge SharedPipes.
    // After wait() returns, drain the bridge into the target stream.
    let stdoutBridgeHandle: SharedPipeHandle | undefined;
    let stderrBridgeHandle: SharedPipeHandle | undefined;
    const stdoutTarget = options?.stdout ?? this.#hostStdout;
    const stderrTarget = options?.stderr ?? this.#hostStderr;
    if (!stdoutHandle && stdoutTarget) {
      stdoutBridgeHandle = createSharedPipeRaw(this.#pipeBufferSize);
    }
    if (!stderrHandle && stderrTarget) {
      stderrBridgeHandle = createSharedPipeRaw(this.#pipeBufferSize);
    }

    // Create exit/signal slots locally — both threads share the same SAB
    const exitSlotBuf = new SharedArrayBuffer(4);
    const signalSlotBuf = new SharedArrayBuffer(4);
    const exitView = new Int32Array(exitSlotBuf);
    const signalView = new Int32Array(signalSlotBuf);
    Atomics.store(exitView, 0, -1);
    Atomics.store(signalView, 0, 0);

    const result = this.#bridge(CALL_SPAWN, null, {
      file,
      args,
      env: options?.env,
      cwd: options?.cwd,
      exitSlotBuf,
      signalSlotBuf,
      stdinBuf: (stdinHandle ?? stdinBridgeHandle)?.buffer,
      stdinBufSize: (stdinHandle ?? stdinBridgeHandle)?.bufferSize,
      stdoutBuf: (stdoutHandle ?? stdoutBridgeHandle)?.buffer,
      stdoutBufSize: (stdoutHandle ?? stdoutBridgeHandle)?.bufferSize,
      stderrBuf: (stderrHandle ?? stderrBridgeHandle)?.buffer,
      stderrBufSize: (stderrHandle ?? stderrBridgeHandle)?.bufferSize,
    }) as SpawnResult;

    const foreground = this.#foreground;
    const bridgeStdout = stdoutBridgeHandle;
    const bridgeStderr = stderrBridgeHandle;
    const bufSize = this.#pipeBufferSize;

    const proc = new Process(result.pid, {
      onKill(signal: Signal) {
        Atomics.store(signalView, 0, SIGNAL_NUMBER[signal]);
        Atomics.notify(signalView, 0);
      },
      wait() {
        foreground.add(proc);
        try {
          while (Atomics.load(exitView, 0) === -1) {
            Atomics.wait(exitView, 0, -1);
          }
          // After process exits, drain bridge pipes into the original streams.
          // Use blockingRead — the Worker already exited so WRITER_CLOSED is set;
          // blockingRead returns data until empty, then throws {tag:'closed'}.
          if (bridgeStdout && stdoutTarget) {
            const reader = inputFromSharedBuffer(bridgeStdout.buffer, bridgeStdout.bufferSize);
            try { while (true) { stdoutTarget.write(reader.blockingRead(BigInt(bufSize))); } } catch { /* closed */ }
            reader[Symbol.dispose]();
          }
          if (bridgeStderr && stderrTarget) {
            const reader = inputFromSharedBuffer(bridgeStderr.buffer, bridgeStderr.bufferSize);
            try { while (true) { stderrTarget.write(reader.blockingRead(BigInt(bufSize))); } } catch { /* closed */ }
            reader[Symbol.dispose]();
          }
          return Atomics.load(exitView, 0);
        } finally {
          foreground.delete(proc);
        }
      },
      tryWait() {
        const code = Atomics.load(exitView, 0);
        return code === -1 ? undefined : code;
      },
    });

    return proc;
  }

  createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream } {
    const bufferSize = options?.bufferSize ?? this.#pipeBufferSize;
    const handle = createSharedPipeRaw(bufferSize);
    const input = inputFromSharedBuffer(handle.buffer, handle.bufferSize);
    const output = outputFromSharedBuffer(handle.buffer, handle.bufferSize);
    this.#pipeHandles.set(input, handle);
    this.#pipeHandles.set(output, handle);
    return { input, output };
  }

  dupOutputStream(stream: OutputStream): OutputStream {
    const handle = this.#pipeHandles.get(stream);
    const dup = stream.dup();
    if (handle) this.#pipeHandles.set(dup, handle);
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
}
