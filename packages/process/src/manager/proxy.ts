import type { BlockingCallFn } from '@mithic/io/io';
import { Process, type ProcessManager, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createSharedPipeRaw, inputFromSharedBuffer, outputFromSharedBuffer, type SharedPipeHandle } from '../io/pipes.ts';
import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { Pollable } from '@mithic/wasip2/io/poll';

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
}

export class ProxyProcessManager implements ProcessManager {
  readonly #bridge: BlockingCallFn;
  readonly #foreground = new Set<Process>();
  readonly #pipeHandles = new WeakMap<object, SharedPipeHandle>();
  readonly #pipeBufferSize: number;

  constructor(bridge: BlockingCallFn, options?: ProxyProcessManagerConfig) {
    this.#bridge = bridge;
    this.#pipeBufferSize = options?.pipeBufferSize ?? 65536;
  }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const stdinHandle = options?.stdin ? this.#pipeHandles.get(options.stdin) : undefined;
    const stdoutHandle = options?.stdout ? this.#pipeHandles.get(options.stdout) : undefined;
    const stderrHandle = options?.stderr ? this.#pipeHandles.get(options.stderr) : undefined;

    // Non-pipe stdin (e.g. file redirect `cmd < file`): read all data into a bridge
    // SharedPipe synchronously before spawning. This is correct because non-pipe stdin
    // only arises from file redirects, which are always finite — pipeline pipes go through
    // createPipe() and are already in #pipeHandles. The read() calls here go through the
    // IoLoop (SyncBridgeFsProvider → main thread → MemoryFsProvider), so the data
    // round-trips the same way regardless. The SharedPipe is then sent to the process
    // Worker for consumption.
    let stdinBridgeHandle: SharedPipeHandle | undefined;
    if (options?.stdin && !stdinHandle) {
      stdinBridgeHandle = createSharedPipeRaw(this.#pipeBufferSize);
      const bridgeOut = outputFromSharedBuffer(stdinBridgeHandle.buffer, stdinBridgeHandle.bufferSize);
      try {
        while (true) {
          const chunk = options.stdin.read(BigInt(this.#pipeBufferSize));
          if (!chunk || chunk.byteLength === 0) break;
          bridgeOut.write(chunk);
        }
      } catch { /* stream closed */ }
      bridgeOut[Symbol.dispose]();
    }

    // For non-pipe, non-inherited stdout/stderr: create bridge SharedPipes.
    // After wait() returns, drain the bridge into the target stream.
    // When no stream is provided (inherit), the Worker uses IoLoop stdio directly — no bridge needed.
    let stdoutBridgeHandle: SharedPipeHandle | undefined;
    let stderrBridgeHandle: SharedPipeHandle | undefined;
    const stdoutTarget = options?.stdout && !stdoutHandle ? options.stdout : undefined;
    const stderrTarget = options?.stderr && !stderrHandle ? options.stderr : undefined;
    if (stdoutTarget) {
      stdoutBridgeHandle = createSharedPipeRaw(this.#pipeBufferSize);
    }
    if (stderrTarget) {
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
      env: Array.isArray(options?.env) ? Object.fromEntries(options.env) : options?.env,
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
      subscribe() {
        return new Pollable(
          () => Atomics.load(exitView, 0) !== -1,
          (maxBlockMs?: number) => {
            if (Atomics.load(exitView, 0) !== -1) return;
            Atomics.wait(exitView, 0, -1, maxBlockMs);
          },
        );
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
