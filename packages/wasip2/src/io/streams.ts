/**
 * Implements wasi:io/streams - input and output stream resources.
 */

import type { IoError } from './error.ts';
import { Pollable } from './poll.ts';

export type StreamError =
  | { tag: 'last-operation-failed'; val: IoError }
  | { tag: 'closed' };

export interface InputStreamHandler {
  /** Non-blocking read. Returns undefined if no data available yet. */
  read?(len: number): Uint8Array | undefined;
  /** Blocking read. Must return data or throw StreamError. */
  blockingRead(len: number): Uint8Array;
  /** Skip bytes, returning count skipped. */
  skip?(len: number): number;
  /** Subscribe for readiness. */
  subscribe?(): Pollable;
  /** Cleanup. */
  drop?(): void;
}

export interface OutputStreamHandler {
  /** Returns available write capacity. */
  checkWrite?(): number;
  /** Write data. */
  write(data: Uint8Array): void;
  /** Flush buffered output. */
  flush?(): void;
  /** Subscribe for write readiness. */
  subscribe?(): Pollable;
  /** Cleanup. */
  drop?(): void;
}

export class InputStream {
  #handler: InputStreamHandler;

  constructor(handler: InputStreamHandler) {
    this.#handler = handler;
  }

  read(len: bigint): Uint8Array {
    const n = Number(len);
    if (this.#handler.read) {
      const data = this.#handler.read(n);
      if (data !== undefined) {
        return data;
      }
      // No data available — return empty (non-blocking semantics)
      return new Uint8Array(0);
    }
    return this.#handler.blockingRead(n);
  }

  blockingRead(len: bigint): Uint8Array {
    return this.#handler.blockingRead(Number(len));
  }

  skip(len: bigint): bigint {
    const n = Number(len);
    if (this.#handler.skip) {
      return BigInt(this.#handler.skip(n));
    }
    if (this.#handler.read) {
      const bytes = this.#handler.read(n);
      return BigInt(bytes?.byteLength ?? 0);
    }
    const bytes = this.#handler.blockingRead(n);
    return BigInt(bytes.byteLength);
  }

  blockingSkip(len: bigint): bigint {
    const n = Number(len);
    if (this.#handler.skip) {
      return BigInt(this.#handler.skip(n));
    }
    const bytes = this.#handler.blockingRead(n);
    return BigInt(bytes.byteLength);
  }

  subscribe(): Pollable {
    if (this.#handler.subscribe) {
      return this.#handler.subscribe();
    }
    return new Pollable();
  }

  [Symbol.dispose](): void {
    if (this.#handler.drop) {
      this.#handler.drop();
    }
  }
}

export class OutputStream {
  #handler: OutputStreamHandler;
  #open = true;

  constructor(handler: OutputStreamHandler) {
    this.#handler = handler;
  }

  checkWrite(): bigint {
    if (!this.#open) {
      return 0n;
    }
    if (this.#handler.checkWrite) {
      return BigInt(this.#handler.checkWrite());
    }
    return 1_000_000n;
  }

  write(contents: Uint8Array): void {
    if (!this.#open) {
      throw { tag: 'closed' } as StreamError;
    }
    this.#handler.write(contents);
  }

  blockingWriteAndFlush(contents: Uint8Array): void {
    if (!this.#open) {
      throw { tag: 'closed' } as StreamError;
    }
    this.#handler.write(contents);
    if (this.#handler.flush) {
      this.#handler.flush();
    }
  }

  flush(): void {
    if (this.#handler.flush) {
      this.#handler.flush();
    }
  }

  blockingFlush(): void {
    if (this.#handler.flush) {
      this.#handler.flush();
    }
  }

  subscribe(): Pollable {
    if (this.#handler.subscribe) {
      return this.#handler.subscribe();
    }
    return new Pollable();
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  blockingWriteZeroesAndFlush(len: bigint): void {
    this.blockingWriteAndFlush(new Uint8Array(Number(len)));
  }

  splice(src: InputStream, len: bigint): bigint {
    const available = Number(this.checkWrite());
    const spliceLen = Math.min(Number(len), available);
    const bytes = src.read(BigInt(spliceLen));
    if (bytes.byteLength > 0) {
      this.#handler.write(bytes);
    }
    return BigInt(bytes.byteLength);
  }

  blockingSplice(src: InputStream, len: bigint): bigint {
    const bytes = src.blockingRead(len);
    if (bytes.byteLength > 0) {
      this.#handler.write(bytes);
      if (this.#handler.flush) {
        this.#handler.flush();
      }
    }
    return BigInt(bytes.byteLength);
  }

  [Symbol.dispose](): void {
    this.#open = false;
    if (this.#handler.drop) {
      this.#handler.drop();
    }
  }
}
