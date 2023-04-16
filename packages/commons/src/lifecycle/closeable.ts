import { AbortOptions, MaybePromise } from '../async/index.js';

/** A resource-holding object that can be closed to release resources. */
export interface Closeable {
  /** Closes this object and releases any system resource associated with it. */
  close(options?: AbortOptions): MaybePromise<void>;
}
