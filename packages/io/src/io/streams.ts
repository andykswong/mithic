/**
 * Stream handler interfaces for I/O operations.
 * These are the core read/write contracts used by the sync-bridge and WASI streams.
 */

import type { MaybePromise } from '../types.ts';

export interface InputStreamHandler {
  read?(len: number): MaybePromise<Uint8Array | undefined>;
  blockingRead(len: number): MaybePromise<Uint8Array>;
  skip?(len: number): MaybePromise<number>;
  drop?(): void;
}

export interface SyncInputStreamHandler extends InputStreamHandler {
  read?(len: number): Uint8Array | undefined;
  blockingRead(len: number): Uint8Array;
  skip?(len: number): number;
  drop?(): void;
}

export interface OutputStreamHandler {
  checkWrite?(): MaybePromise<number>;
  write(data: Uint8Array): MaybePromise<void>;
  flush?(): MaybePromise<void>;
  drop?(): void;
}

export interface SyncOutputStreamHandler extends OutputStreamHandler {
  checkWrite?(): number;
  write(data: Uint8Array): void;
  flush?(): void;
  drop?(): void;
}
