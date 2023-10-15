import { Lock } from './lock.js';
import { AbortOptions } from './options.js';
import { MaybePromise } from './promise.js';

/** A simple counting semaphore that limits access to resources with a fixed number of permits. */
export class CountingSemaphore implements Lock {
  private leased = 0;
  private released?: Promise<void>;
  private onRelease?: () => void;

  public constructor(
    /** Total number of permits. */
    public readonly permits = 1,
  ) {
  }

  /** Returns the number of permits available for use. */
  public get availablePermits(): number {
    return this.permits - this.leased;
  }

  public acquire(options?: AbortOptions): MaybePromise<void> {
    if (this.tryAcquire()) {
      return;
    }
    return this.waitToAcquire(options);
  }

  public tryAcquire(): boolean {
    if (this.leased < this.permits) {
      ++this.leased;
      return true;
    }
    return false;
  }

  public release(): void {
    this.leased = Math.max(0, --this.leased);
    this.onRelease?.();
    this.released = void 0;
  }

  private async waitToAcquire(options?: AbortOptions): Promise<void> {
    do {
      if (!this.released) {
        this.released = new Promise((resolve) => {
          this.onRelease = resolve;
        });
      }
      await this.released;
      options?.signal?.throwIfAborted();
    } while (!this.tryAcquire());
  }
}

/** A counting semaphore that uses a shared array buffer for synchronization. */
export class SharedCountingSemaphore implements Lock, SharedCountingSemaphoreOptions {
  public readonly buffer: Int32Array;
  public readonly index: number;
  public readonly permits: number;
  public readonly waitInterval: number;

  public constructor({ buffer, index = 0, permits = 1, waitInterval = 200 }: SharedCountingSemaphoreOptions = {}) {
    this.index = index;
    this.permits = permits;
    this.waitInterval = waitInterval;
    if (buffer && buffer.length > 0) {
      this.buffer = buffer;
    } else {
      this.buffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(this.buffer, 0, permits);
    }
  }

  /** Returns the number of permits available for use. */
  public get availablePermits(): number {
    return Atomics.load(this.buffer, this.index);
  }

  public async acquire(options?: AbortOptions): Promise<void> {
    while (!this.tryAcquire()) {
      options?.signal?.throwIfAborted();
      await Atomics.waitAsync(this.buffer, this.index, 0, this.waitInterval).value;
    }
  }

  public tryAcquire(): boolean {
    for (; ;) {
      const permits = this.availablePermits;
      if (permits <= 0) {
        return false;
      }
      if (Atomics.compareExchange(this.buffer, this.index, permits, permits - 1) === permits) {
        return true;
      }
    }
  }

  public release(): void {
    for (; ;) {
      const permits = this.availablePermits;
      if (permits >= this.permits) {
        break;
      }
      if (Atomics.compareExchange(this.buffer, this.index, permits, permits + 1) === permits) {
        Atomics.notify(this.buffer, this.index);
        break;
      }
    }
  }
}

/** Options for creating a {@link SharedCountingSemaphore}. */
export interface SharedCountingSemaphoreOptions {
  /** Max number of permits. Defaults to 1. */
  permits?: number;

  /** Shared array buffer for permit synchronization. */
  buffer?: Int32Array;

  /** The buffer index to use for permit synchronization. Defaults to 0. */
  index?: number;

  /** The interval in milliseconds to wait for a permit. Defaults to 200. */
  waitInterval?: number;
}
