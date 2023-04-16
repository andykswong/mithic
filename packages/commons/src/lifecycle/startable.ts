import { AbortOptions, MaybePromise } from '../async/index.js';
import { Closeable } from './closeable.js';

/** A component that can be started and closed later. */
export interface Startable extends Closeable {
  /** Returns if this has started. */
  readonly started: boolean;

  /** Starts this component. */
  start(options?: AbortOptions): MaybePromise<void>;
}
