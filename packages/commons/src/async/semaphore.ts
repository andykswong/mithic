import { MaybePromise } from './index.ts';

/** A counting semaphore/lock interface. */
export interface Semaphore {
  /**
   * Blocking waits for the semaphore to be at or above given count and consumes it, or until timeout.
   * Returns true if successful, false otherwise. Defaults to count being 1 with no timeout.
   */
  wait(count?: number, timeoutMs?: number): boolean;

  /**
   * Asynchronously waits for the semaphore to be at or above given count and consumes it, or until timeout.
   * Returns true if successful, false otherwise. Defaults to count being 1 with no timeout.
   */
  waitAsync(count?: number, timeoutMs?: number): MaybePromise<boolean>;

  /** Increments the semaphore given given count and notifies waiting agents. */
  notify(count?: number): MaybePromise<void>;
}

/** A counting semaphore that uses SharedArrayBuffer and Atomics for synchronization. */
export class AtomicSemaphore implements Semaphore, AtomicSemaphoreOptions {
  public readonly buffer: Int32Array;
  public readonly index: number;

  public constructor({
    buffer = new Int32Array(new SharedArrayBuffer(4)),
    index = 0
  }: AtomicSemaphoreOptions = {}) {
    this.buffer = buffer;
    this.index = index;
  }

  /** Returns the current state of the semaphore. */
  public get state(): number {
    return Atomics.load(this.buffer, this.index);
  }

  public wait(count = 1, timeoutMs?: number): boolean {
    const currentCount = Atomics.load(this.buffer, this.index);
    if (
      currentCount < count && (
        timeoutMs === 0 ||
        Atomics.wait(this.buffer, this.index, currentCount, timeoutMs) === 'timed-out'
      )
    ) {
      return false;
    }
    return this.consume(count);
  }

  public waitAsync(count = 1, timeoutMs?: number): MaybePromise<boolean> {
    let success: MaybePromise<boolean> = true;
    const currentCount = Atomics.load(this.buffer, this.index);
    if (currentCount < count) {
      const result = Atomics.waitAsync(this.buffer, this.index, currentCount, timeoutMs);
      success = MaybePromise.map(result.value, isReady);
    }
    return MaybePromise.map(success, (success) => success && this.consume(count));
  }

  public notify(count = 1): void {
    if (Atomics.add(this.buffer, this.index, count) + count > 0) {
      Atomics.notify(this.buffer, this.index);
    }
  }

  private consume(count: number): boolean {
    let currentCount;
    do {
      currentCount = Atomics.load(this.buffer, this.index);
      if (currentCount < count) {
        return false;
      }
    } while (Atomics.compareExchange(this.buffer, this.index, currentCount, currentCount - count) !== currentCount);
    return true;
  }
}

/** Options for creating a {@link AtomicSemaphore}. */
export interface AtomicSemaphoreOptions {
  /** Shared array buffer for permit synchronization. */
  readonly buffer?: Int32Array;

  /** The buffer index to use for permit synchronization. Defaults to 0. */
  readonly index?: number;
}

function isReady(state: 'ok' | 'not-equal' | 'timed-out'): boolean {
  return state === 'ok' || state === 'not-equal';
}
