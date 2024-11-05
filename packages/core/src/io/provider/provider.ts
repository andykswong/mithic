import { type MaybeDisposable } from '@mithic/commons';

/** Provider of I/O stream operations. */
export interface IoProvider extends MaybeDisposable {
  /** Returns the state of given stream. */
  state(fd: number): number;

  /** Performs a non-blocking read. */
  read(fd: number, len: number): Uint8Array | undefined;

  /** Returns the number of readable bytes in the buffer, or -1 if stream is closed. */
  checkRead(fd: number): number;

  /** Performs a non-blocking write. */
  write(fd: number, data: Uint8Array): void;

  /** Checks the maximum number of bytes to write. */
  checkWrite(fd: number): number;

  /**
   * Blocking waits until at least 1 incoming I/O event is processed or timeout,
   * and returns the number of events being processed.
   */
  blockingProcess(timeoutMs?: number): number;

  /** Processes received I/O events and returns the number of events being processed. */
  process(): number;

  /** Blocks until all data is flushed or timeout, and returns if the operation is successful. */
  flush(timeoutMs?: number): boolean;
}
