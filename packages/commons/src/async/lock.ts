import { AbortOptions } from './options.js';
import { MaybePromise } from './promise.js';

/** A lock for controlling concurrent access to shared resource. */
export interface Lock {
  /** Waits for a lock to be acquired. */
  acquire(options?: AbortOptions): MaybePromise<void>;

  /** Tried to acquire a lock. Returns true if success, false otherwise. */
  tryAcquire(options?: AbortOptions): MaybePromise<boolean>;

  /** Releases a lock. */
  release(options?: AbortOptions): MaybePromise<void>;
}

/** A lock that does nothing. Useful for testing / running single-threaded. */
export class NoOpLock implements Lock {
  acquire(): void {
    // no-op
  }

  tryAcquire(): boolean {
    return true;
  }

  release(): void {
    // no-op
  }
}
