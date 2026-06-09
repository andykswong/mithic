/**
 * Stream handler interfaces for I/O operations.
 * These are the core read/write contracts used by the sync-bridge and WASI streams.
 *
 * Non-blocking methods (read, skip, checkWrite, write) are always synchronous.
 * Blocking methods (blockingRead, flush) may return Promises — asyncify/JSPI
 * handles suspension at the WASM boundary.
 */

import type { MaybePromise } from '../types.ts';

export interface InputStreamHandler<Sync extends boolean = boolean> {
  read(len: number): Uint8Array | undefined;
  blockingRead(len: number): MaybePromise<Uint8Array, Sync>;
  skip?(len: number): number;
  drop?(): void;
}

export type SyncInputStreamHandler = InputStreamHandler<true>;

export interface OutputStreamHandler<Sync extends boolean = boolean> {
  checkWrite?(): number;
  write(data: Uint8Array): void;
  flush?(): MaybePromise<void, Sync>;
  drop?(): void;
}

export type SyncOutputStreamHandler = OutputStreamHandler<true>;
