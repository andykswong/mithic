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

/** Options for acquiring/releasing a {@link Lock} with a key. */
export interface LockKeyOptions<K = string> extends AbortOptions {
  /** key of the lock to acquire/release. */
  key?: K;
} 

/** Options for acquiring a {@link Lock} that may be shared. */
export interface ReadWriteLockAcquireOptions extends AbortOptions {
  /** True if the lock should be shared, false if exclusive. */
  shared?: boolean;
} 
