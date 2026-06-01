import type { BlockingCallFn } from '@mithic/io/io';
import { Process, type ProcessManager, type SpawnOptions, type Signal, type PipeOptions, SIGNAL_NUMBER } from '../types.ts';
import { createPipe } from '../utils.ts';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';

export const CALL_SPAWN = 10;

interface SpawnResult {
  pid: number;
  exitSlotBuf: SharedArrayBuffer;
  signalSlotBuf: SharedArrayBuffer;
}

export class ProxyProcessManager implements ProcessManager {
  readonly #bridge: BlockingCallFn;
  readonly #foreground = new Set<Process>();

  constructor(bridge: BlockingCallFn) {
    this.#bridge = bridge;
  }

  spawn(file: string, args: string[], options?: SpawnOptions): Process {
    const result = this.#bridge(CALL_SPAWN, null, {
      file,
      args,
      env: options?.env,
      cwd: options?.cwd,
    }) as SpawnResult;

    const exitView = new Int32Array(result.exitSlotBuf);
    const signalView = new Int32Array(result.signalSlotBuf);
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
    return createPipe({ ...options, shared: true });
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
