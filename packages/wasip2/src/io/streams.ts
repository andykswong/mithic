/**
 * Implements wasi:io/streams - input and output stream resources.
 */

import { type MaybePromise, isThenable } from '@mithic/io';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';
import type { IoError } from './error.ts';
import { Pollable } from './poll.ts';

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export type { InputStreamHandler, OutputStreamHandler };

export type StreamError =
  | { tag: 'last-operation-failed'; val: IoError }
  | { tag: 'closed' };

export function isStreamClosed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'tag' in error && (error as StreamError).tag === 'closed';
}

export class InputStream<Sync extends boolean = boolean> {
  #handler: InputStreamHandler<Sync>;
  #subscribe?: () => Pollable;
  #isatty: boolean;
  #refs: { count: number };
  #disposed = false;

  constructor(handler: InputStreamHandler<Sync>, subscribe?: () => Pollable, isatty = false, refs?: { count: number }) {
    this.#handler = handler;
    this.#subscribe = subscribe;
    this.#isatty = isatty;
    this.#refs = refs ?? { count: 1 };
  }

  dup(): InputStream<Sync> {
    this.#refs.count++;
    return new InputStream(this.#handler, this.#subscribe, this.#isatty, this.#refs);
  }

  /** Return a borrowed view that delegates to this stream but does not participate in ref counting. Dispose on the borrow is a no-op — the owner retains responsibility for dropping. */
  borrow(): InputStream<Sync> {
    const h = this.#handler;
    const handler: InputStreamHandler<Sync> = {
      read: (len) => h.read(len),
      blockingRead: (len) => h.blockingRead(len),
      skip: h.skip ? (len) => h.skip!(len) : undefined,
    };
    return new InputStream(handler, this.#subscribe, this.#isatty);
  }

  /** Force-drop: drop handler and zero refs regardless of other handles. */
  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#refs.count > 0) {
      this.#refs.count = 0;
      if (this.#handler.drop) this.#handler.drop();
    }
  }

  get isatty(): boolean { return this.#isatty; }

  read(len: bigint): Uint8Array {
    const data = this.#handler.read(Number(len));
    return data ?? new Uint8Array(0);
  }

  blockingRead(len: bigint): MaybePromise<Uint8Array, Sync> {
    return this.#handler.blockingRead(Number(len));
  }

  skip(len: bigint): bigint {
    const n = Number(len);
    if (this.#handler.skip) {
      return BigInt(this.#handler.skip(n));
    }
    const bytes = this.#handler.read(n);
    return BigInt(bytes?.byteLength ?? 0);
  }

  blockingSkip(len: bigint): MaybePromise<bigint, Sync> {
    const n = Number(len);
    if (this.#handler.skip) {
      return BigInt(this.#handler.skip(n));
    }
    const result = this.#handler.blockingRead(n);
    if (isThenable(result)) {
      return result.then(bytes => BigInt(bytes.byteLength)) as MaybePromise<bigint, Sync>;
    }
    return BigInt(result.byteLength);
  }

  subscribe(): Pollable {
    if (this.#subscribe) {
      return this.#subscribe();
    }
    const handler = this.#handler;
    return new Pollable(
      () => handler.read(0) !== undefined,
      (maxBlockMs?) => {
        Atomics.wait(sleepBuf, 0, 0, maxBlockMs ?? 1);
      },
    );
  }

  /** Ref-counted dispose: drop handler only when last handle is disposed. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#refs.count > 0 && --this.#refs.count === 0 && this.#handler.drop) {
      this.#handler.drop();
    }
  }
}

export class OutputStream<Sync extends boolean = boolean> {
  #handler: OutputStreamHandler<Sync>;
  #subscribe?: () => Pollable;
  #isatty: boolean;
  #disposed = false;
  #refs: { count: number };

  constructor(handler: OutputStreamHandler<Sync>, subscribe?: () => Pollable, isatty = false, refs?: { count: number }) {
    this.#handler = handler;
    this.#subscribe = subscribe;
    this.#isatty = isatty;
    this.#refs = refs ?? { count: 1 };
  }

  dup(): OutputStream<Sync> {
    this.#refs.count++;
    return new OutputStream(this.#handler, this.#subscribe, this.#isatty, this.#refs);
  }

  /** Return a borrowed view that delegates to this stream but does not participate in ref counting. Dispose on the borrow is a no-op — the owner retains responsibility for dropping. */
  borrow(): OutputStream<Sync> {
    const h = this.#handler;
    const handler: OutputStreamHandler<Sync> = {
      write: (data) => h.write(data),
      flush: h.flush ? () => h.flush!() : undefined,
      checkWrite: h.checkWrite ? () => h.checkWrite!() : undefined,
    };
    return new OutputStream(handler, this.#subscribe, this.#isatty);
  }

  /** Force-drop: drop handler and zero refs regardless of other handles. */
  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#refs.count > 0) {
      this.#refs.count = 0;
      if (this.#handler.drop) this.#handler.drop();
    }
  }

  get isatty(): boolean { return this.#isatty; }

  checkWrite(): bigint {
    if (this.#disposed) {
      return 0n;
    }
    if (this.#handler.checkWrite) {
      return BigInt(this.#handler.checkWrite() as number);
    }
    return 1_000_000n;
  }

  write(contents: Uint8Array): void {
    if (this.#disposed) {
      throw { tag: 'closed' } as StreamError;
    }
    this.#handler.write(contents);
  }

  blockingWriteAndFlush(contents: Uint8Array): MaybePromise<void, Sync> {
    if (this.#disposed) {
      throw { tag: 'closed' } as StreamError;
    }
    let offset = 0;
    const writeLoop = (): MaybePromise<void, Sync> => {
      while (offset < contents.byteLength) {
        const capacity = Number(this.checkWrite());
        if (capacity <= 0) {
          const pollable = this.subscribe();
          const result = pollable.block();
          if (isThenable(result)) {
            return (result as Promise<void>).then(writeLoop) as MaybePromise<void, Sync>;
          }
          continue;
        }
        const chunk = contents.subarray(offset, offset + Math.min(contents.byteLength - offset, capacity));
        this.write(chunk);
        offset += chunk.byteLength;
      }
      return this.flush();
    };
    return writeLoop();
  }

  flush(): MaybePromise<void, Sync> {
    if (this.#handler.flush) return this.#handler.flush();
  }

  blockingFlush(): MaybePromise<void, Sync> {
    if (this.#handler.flush) return this.#handler.flush();
  }

  subscribe(): Pollable {
    if (this.#subscribe) {
      return this.#subscribe();
    }
    const handler = this.#handler;
    return new Pollable(
      () => !handler.checkWrite || handler.checkWrite() > 0,
      (maxBlockMs?) => {
        Atomics.wait(sleepBuf, 0, 0, maxBlockMs ?? 1);
      },
    );
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  splice(src: InputStream<Sync>, len: bigint): bigint {
    const n = Number(len);
    const capacity = Number(this.checkWrite());
    const toRead = Math.min(n, capacity);
    if (toRead <= 0) return 0n;

    const data = src.read(BigInt(toRead));
    if (data.byteLength === 0) return 0n;
    this.write(data);
    return BigInt(data.byteLength);
  }

  blockingSplice(src: InputStream<Sync>, len: bigint): MaybePromise<bigint, Sync> {
    const n = Number(len);
    const result = src.blockingRead(BigInt(n));
    if (isThenable(result)) {
      return result.then(data => {
        if (data.byteLength === 0) return 0n;
        this.write(data);
        this.flush();
        return BigInt(data.byteLength);
      }) as MaybePromise<bigint, Sync>;
    }
    const data = result as Uint8Array;
    if (data.byteLength === 0) return 0n;
    this.write(data);
    this.flush();
    return BigInt(data.byteLength);
  }

  /** Ref-counted dispose: drop handler only when last handle is disposed. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#refs.count > 0 && --this.#refs.count === 0 && this.#handler.drop) {
      this.#handler.drop();
    }
  }
}
