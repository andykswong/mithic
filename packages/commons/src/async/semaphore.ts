import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A data structure that maintains a set of permits to limit access. */
export interface Semaphore {
  /** Waits for a permit to be acquired. */
  acquire(options?: AbortOptions): MaybePromise<void>;

  /** Tried to acquire a permit. Returns true if success, false otherwise. */
  tryAcquire(): boolean;

  /** Releases a permit. */
  release(): void;
}

/** A counting {@link Semaphore} limits access to resources with a fixed number of permits. */
export class CountingSemaphore implements Semaphore {
  private leased = 0;
  private released?: Promise<void>;
  private onRelease?: () => void;

  public constructor(
    /** Total number of permits. */
    private readonly permits = 1,
  ) {
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
