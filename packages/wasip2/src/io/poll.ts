/**
 * Implements wasi:io/poll - pollable resource and poll function.
 */

export class Pollable {
  #pollReady: () => boolean;

  constructor(pollReady?: () => boolean) {
    this.#pollReady = pollReady ?? (() => true);
  }

  ready(): boolean {
    return this.#pollReady();
  }

  block(): void {
    // In sync mode, spin until ready or return immediately if always-ready.
    // For in-memory providers this should resolve immediately.
    if (!this.#pollReady()) {
      // Spin — in sync mode the pollable should become ready immediately
      // since underlying providers are synchronous.
      let attempts = 0;
      while (!this.#pollReady()) {
        attempts++;
        if (attempts > 1_000_000) {
          throw new Error('Pollable.block() timed out — async provider cannot be used in sync mode');
        }
      }
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
    // In sync mode, block on first pollable and sweep
    for (let i = 0; i < pollables.length; i++) {
      pollables[i].block();
      if (pollables[i].ready()) {
        ready.push(i);
        break;
      }
    }
    // Sweep for others that became ready
    for (let i = 0; i < pollables.length; i++) {
      if (!ready.includes(i) && pollables[i].ready()) {
        ready.push(i);
      }
    }
  }

  return new Uint32Array(ready);
}
