import { type MaybePromise, isThenable } from '@mithic/io';

export class Pollable<Sync extends boolean = boolean> {
  #pollReady: () => boolean;
  #blockReady: (maxBlockMs?: number) => MaybePromise<void, Sync>;
  #timeoutMs?: () => number;

  constructor(
    pollReady: () => boolean,
    blockReady: (maxBlockMs?: number) => MaybePromise<void, Sync>,
    timeoutMs?: () => number,
  ) {
    this.#pollReady = pollReady;
    this.#blockReady = blockReady;
    this.#timeoutMs = timeoutMs;
  }

  ready(): boolean { return this.#pollReady(); }

  block(maxBlockMs?: number): MaybePromise<void, Sync> {
    if (this.#pollReady()) return;
    const result = this.#blockReady(maxBlockMs);
    if (isThenable(result)) return result;
    if (maxBlockMs !== undefined) return;
    while (!this.#pollReady()) {
      this.#blockReady();
    }
  }

  timeoutMs(): number | undefined { return this.#timeoutMs?.(); }
}

export function poll<Sync extends boolean>(pollables: Pollable<Sync>[]): MaybePromise<Uint32Array, Sync> {
  const N = pollables.length;
  if (N === 0) throw new Error('poll list must not be empty');

  // Fast path: any already ready?
  let ready = scanReady(pollables);
  if (ready.length > 0) return new Uint32Array(ready);

  // Classify pollables
  let minTimeout: number | undefined;
  const dataIndices: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = pollables[i].timeoutMs();
    if (t !== undefined) {
      minTimeout = minTimeout === undefined ? t : Math.min(minTimeout, t);
    } else {
      dataIndices.push(i);
    }
  }

  // First pass: detect async vs sync
  const promises: Promise<void>[] = [];
  const firstPassBlock = N === 1 ? minTimeout : 1;
  for (let i = 0; i < N; i++) {
    const result = pollables[i].block(firstPassBlock);
    if (isThenable(result)) {
      promises.push(result as Promise<void>);
    } else {
      ready = scanReady(pollables);
      if (ready.length > 0) return new Uint32Array(ready);
    }
  }

  // Async path: Promise.race
  if (promises.length > 0) {
    return Promise.race(promises).then(
      () => new Uint32Array(scanReady(pollables)),
    ) as MaybePromise<Uint32Array, Sync>;
  }

  // Sync optimized: 0 data (only timers) -> block shortest timer
  if (dataIndices.length === 0 && minTimeout !== undefined) {
    const shortest = pollables.reduce((a, b) =>
      (a.timeoutMs() ?? Infinity) < (b.timeoutMs() ?? Infinity) ? a : b);
    shortest.block(minTimeout);
    return new Uint32Array(scanReady(pollables));
  }

  // Sync general: N data +/- timers -> iterate with 1ms slices
  const deadline = minTimeout !== undefined ? performance.now() + minTimeout : undefined;
  while (deadline === undefined || performance.now() < deadline) {
    for (let i = 0; i < N; i++) {
      pollables[i].block(1);
      ready = scanReady(pollables);
      if (ready.length > 0) return new Uint32Array(ready);
    }
  }

  // Outer bound reached — timer pollable(s) guaranteed ready
  return new Uint32Array(scanReady(pollables));
}

function scanReady(pollables: Pollable[]): number[] {
  const ready: number[] = [];
  for (let i = 0; i < pollables.length; i++) {
    if (pollables[i].ready()) ready.push(i);
  }
  return ready;
}
