/**
 * Implements wasi:io/poll - pollable resource and poll function.
 *
 * Uses Atomics.wait as a sync bridge for blocking: instead of busy-spinning,
 * the thread truly sleeps (yields to the OS scheduler) between readiness checks.
 *
 * Pollables may provide a `blockReady` function for optimal blocking (e.g.,
 * clock pollables sleep for the exact duration in one Atomics.wait call).
 * Without `blockReady`, block() falls back to polling with 1ms sleep intervals.
 *
 * When `blockReady` returns a Promise (async mode), block() and poll() propagate
 * the Promise to enable asyncify/JSPI-based suspension at the WASM boundary.
 */

import { type MaybePromise, isThenable } from '@mithic/io';

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

export class Pollable<Sync extends boolean = boolean> {
  #pollReady: () => boolean;
  #blockReady?: () => MaybePromise<void, Sync>;

  constructor(pollReady?: () => boolean, blockReady?: () => MaybePromise<void, Sync>) {
    this.#pollReady = pollReady ?? (() => true);
    this.#blockReady = blockReady;
  }

  ready(): boolean {
    return this.#pollReady();
  }

  block(): MaybePromise<void, Sync> {
    if (this.#pollReady()) return;

    if (this.#blockReady) {
      const result = this.#blockReady();
      if (isThenable(result)) return result;
      if (this.#pollReady()) return;
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
 *
 * When all pollables are not immediately ready and a blockReady returns a Promise,
 * poll() returns a Promise<Uint32Array> that resolves after the first async
 * pollable completes.
 */
export function poll<Sync extends boolean = boolean>(pollables: Pollable<Sync>[]): MaybePromise<Uint32Array, Sync> {
  if (pollables.length === 0) {
    throw new Error('poll list must not be empty');
  }
  if (pollables.length > 0xffffffff) {
    throw new Error('poll list length exceeds u32 index range');
  }

  // Fast path: check all pollables for immediate readiness
  const ready: number[] = [];
  for (let i = 0; i < pollables.length; i++) {
    if (pollables[i].ready()) {
      ready.push(i);
    }
  }

  if (ready.length > 0) {
    return new Uint32Array(ready);
  }

  // Slow path: try blocking each pollable one-by-one
  const pendingPromises: Promise<void>[] = [];
  for (let i = 0; i < pollables.length; i++) {
    const result = pollables[i].block();
    if (isThenable(result)) {
      pendingPromises.push(result as Promise<void>);
    } else {
      // Sync block completed — check if now ready
      if (pollables[i].ready()) {
        ready.push(i);
        // Also check all other pollables for readiness
        for (let j = 0; j < pollables.length; j++) {
          if (j !== i && pollables[j].ready()) {
            ready.push(j);
          }
        }
        return new Uint32Array(ready);
      }
    }
  }

  // Async path: race pending promises, then collect ready indices
  if (pendingPromises.length > 0) {
    return Promise.race(pendingPromises).then(() => {
      const asyncReady: number[] = [];
      for (let i = 0; i < pollables.length; i++) {
        if (pollables[i].ready()) {
          asyncReady.push(i);
        }
      }
      if (asyncReady.length > 0) {
        return new Uint32Array(asyncReady);
      }
      // Defensive fallback: Promise.race resolved but no pollable reports ready.
      // This should not happen in normal operation; return first index per WASI spec
      // which requires at least one ready index in the result.
      return new Uint32Array([0]);
    }) as MaybePromise<Uint32Array, Sync>;
  }

  // Fallback: no pollable became ready synchronously, none are async.
  // Per WASI spec poll must return at least one ready index; return first as defensive default.
  return new Uint32Array([0]);
}
