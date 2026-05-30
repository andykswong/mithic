/**
 * Implements wasi:io/poll - pollable resource and poll function.
 *
 * Uses Atomics.wait as a sync bridge for blocking: instead of busy-spinning,
 * the thread truly sleeps (yields to the OS scheduler) between readiness checks.
 *
 * Pollables may provide a `blockReady` function for optimal blocking (e.g.,
 * clock pollables sleep for the exact duration in one Atomics.wait call).
 * Without `blockReady`, block() falls back to polling with 1ms sleep intervals.
 */

let globalBlockTimeout = 60_000;
let sleepBuffer: Int32Array | undefined;

function getSleepBuffer(): Int32Array {
  if (!sleepBuffer) {
    sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  }
  return sleepBuffer;
}

export function setBlockTimeout(ms: number): void {
  globalBlockTimeout = ms;
}

export class Pollable {
  #pollReady: () => boolean;
  #blockReady?: () => void;

  constructor(pollReady?: () => boolean, blockReady?: () => void) {
    this.#pollReady = pollReady ?? (() => true);
    this.#blockReady = blockReady;
  }

  ready(): boolean {
    return this.#pollReady();
  }

  block(): void {
    if (this.#pollReady()) return;

    if (this.#blockReady) {
      this.#blockReady();
      return;
    }

    const deadline = performance.now() + globalBlockTimeout;
    const buf = getSleepBuffer();
    while (!this.#pollReady()) {
      if (performance.now() > deadline) {
        throw new Error(`Pollable.block() timed out after ${globalBlockTimeout}ms`);
      }
      Atomics.wait(buf, 0, 0, 1);
    }
  }
}

/**
 * Poll for completion on a set of pollables.
 * Returns indices of pollables that are ready.
 * Traps if list is empty or exceeds u32 range.
 */
export function poll(pollables: Pollable[]): Uint32Array {
  if (pollables.length === 0) {
    throw new Error('poll list must not be empty');
  }
  if (pollables.length > 0xffffffff) {
    throw new Error('poll list length exceeds u32 index range');
  }

  const ready: number[] = [];
  for (let i = 0; i < pollables.length; i++) {
    if (pollables[i].ready()) {
      ready.push(i);
    }
  }

  if (ready.length === 0) {
    for (let i = 0; i < pollables.length; i++) {
      pollables[i].block();
      if (pollables[i].ready()) {
        ready.push(i);
        break;
      }
    }
    for (let i = 0; i < pollables.length; i++) {
      if (!ready.includes(i) && pollables[i].ready()) {
        ready.push(i);
      }
    }
  }

  return new Uint32Array(ready);
}
