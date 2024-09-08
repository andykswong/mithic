import type { MaybePromise } from '../async/promise.ts';

/** A data channel. */
export interface Channel<T> {
  /** The maximum byte length of data that the internal send buffer can hold. */
  readonly maxSendSize: number;

  /** Sends given message and returns if message is sent. */
  send(message: T): boolean;

  /** Pops a message if available. */
  receive(): T | undefined;

  /** Blocks until new data is received or timeout, and returns if data is available. */
  wait(timeoutMs?: number): boolean;

  /** Asynchronously wait until new data is received or timeout, and returns if data is available. */
  waitAsync(timeoutMs?: number): MaybePromise<boolean>;

  /** Blocks until send queue is flushed or timeout, and returns if flushed. */
  flush(timeoutMs?: number): boolean;

  /** Asynchronously waits for send queue to be flushed or timeout. and returns if flushed. */
  flushAsync(timeoutMs?: number): MaybePromise<boolean>;
}
