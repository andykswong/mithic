import type { MaybePromise } from '@mithic/commons';

/** Read stream adapter. */
export interface ReadStream extends Partial<Disposable> {
  /**
   * Performs a non-blocking read.
   * @throws {@link StreamError}
   */
  read(len: number): Uint8Array | undefined;

  /**
   * Returns the number of bytes in the read buffer.
   * @throws {@link StreamError}
   */
  checkRead(): number;

  /** If read buffer is empty, tries to poll data until timeout, and returns if data is available. */
  poll(timeoutMs?: number): MaybePromise<boolean>;
}

/** Write stream adapter. */
export interface WriteStream extends Partial<Disposable> {
  /**
   * Performs a non-blocking write.
   * @throws {@link StreamError}
   */
  write(data: Uint8Array): void;

  /**
   * Returns the maximum number of bytes to write.
   * @throws {@link StreamError}
   */
  checkWrite(): number;

  /** Waits until all data is flushed or timeout, and returns if the operation is successful. */
  flush(timeoutMs?: number): MaybePromise<boolean>;
}

/** Synchronous read stream interface. */
export interface SyncReadStream extends ReadStream {
  poll(timeoutMs?: number): boolean;
}

/** Synchronous write stream interface. */
export interface SyncWriteStream extends WriteStream {
  flush(timeoutMs?: number): boolean;
}
