/**
 * Implements wasi:io/streams - input and output stream resources.
 */

import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '@mithic/io/io';
import type { IoError } from './error.ts';
import { Pollable } from './poll.ts';

export type { SyncInputStreamHandler as InputStreamHandler, SyncOutputStreamHandler as OutputStreamHandler };

export type StreamError =
  | { tag: 'last-operation-failed'; val: IoError }
  | { tag: 'closed' };

export function isStreamClosed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'tag' in error && (error as StreamError).tag === 'closed';
}

export class InputStream {
  #handler: SyncInputStreamHandler;
  #subscribe?: () => Pollable;
  #isatty: boolean;

  constructor(handler: SyncInputStreamHandler, subscribe?: () => Pollable, isatty = false) {
    this.#handler = handler;
    this.#subscribe = subscribe;
    this.#isatty = isatty;
  }

  get isatty(): boolean { return this.#isatty; }

  read(len: bigint): Uint8Array {
    const n = Number(len);
    if (this.#handler.read) {
      const data = this.#handler.read(n);
      if (data !== undefined) {
        return data;
      }
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
    if (this.#subscribe) {
      return this.#subscribe();
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
  #handler: SyncOutputStreamHandler;
  #subscribe?: () => Pollable;
  #isatty: boolean;
  #open = true;

  constructor(handler: SyncOutputStreamHandler, subscribe?: () => Pollable, isatty = false) {
    this.#handler = handler;
    this.#subscribe = subscribe;
    this.#isatty = isatty;
  }

  get isatty(): boolean { return this.#isatty; }

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
    if (this.#subscribe) {
      return this.#subscribe();
    }
    return new Pollable();
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  splice(src: InputStream, len: bigint): bigint {
    const n = Number(len);
    const capacity = Number(this.checkWrite());
    const toRead = Math.min(n, capacity);
    if (toRead <= 0) return 0n;

    const data = src.read(BigInt(toRead));
    if (data.byteLength === 0) return 0n;
    this.write(data);
    return BigInt(data.byteLength);
  }

  blockingSplice(src: InputStream, len: bigint): bigint {
    const n = Number(len);
    const data = src.blockingRead(BigInt(n));
    if (data.byteLength === 0) return 0n;
    this.write(data);
    this.flush();
    return BigInt(data.byteLength);
  }

  [Symbol.dispose](): void {
    this.#open = false;
    if (this.#handler.drop) {
      this.#handler.drop();
    }
  }
}
