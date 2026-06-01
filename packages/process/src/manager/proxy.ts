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
export class ProxyProcessManager implements ProcessManager {
  readonly #bridge: BlockingCallFn;
  readonly #foreground = new Set<Process>();
  readonly #pipeHandles = new WeakMap<object, SharedPipeHandle>();
  readonly #pipeBufferSize: number;

  constructor(bridge: BlockingCallFn, options?: { pipeBufferSize?: number }) {
    this.#bridge = bridge;
    this.#pipeBufferSize = options?.pipeBufferSize ?? 65536;
  }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const stdinHandle = options?.stdin ? this.#pipeHandles.get(options.stdin) : undefined;
    const stdoutHandle = options?.stdout ? this.#pipeHandles.get(options.stdout) : undefined;
    const stderrHandle = options?.stderr ? this.#pipeHandles.get(options.stderr) : undefined;

    // Create exit/signal slots locally — both threads share the same SAB
    const exitSlotBuf = new SharedArrayBuffer(4);
    const signalSlotBuf = new SharedArrayBuffer(4);
    const exitView = new Int32Array(exitSlotBuf);
    const signalView = new Int32Array(signalSlotBuf);
    Atomics.store(exitView, 0, -1); // -1 = not exited
    Atomics.store(signalView, 0, 0); // 0 = no signal

    const result = this.#bridge(CALL_SPAWN, null, {
      file,
      args,
      env: options?.env,
      cwd: options?.cwd,
      exitSlotBuf,
      signalSlotBuf,
      stdinBuf: stdinHandle?.buffer,
      stdinBufSize: stdinHandle?.bufferSize,
      stdoutBuf: stdoutHandle?.buffer,
      stdoutBufSize: stdoutHandle?.bufferSize,
      stderrBuf: stderrHandle?.buffer,
      stderrBufSize: stderrHandle?.bufferSize,
    }) as SpawnResult;

    const foreground = this.#foreground;

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
