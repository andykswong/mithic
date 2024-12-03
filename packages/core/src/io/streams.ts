import { dispose, Error, MaybePromise } from '@mithic/commons';
import { Pollable } from './poll.ts';
import type { ReadStream, WriteStream } from './adapters.ts';
import { StreamError, StreamErrorTag } from './types.ts';

const CHUNK_SIZE = 4096;

/** An input bytestream. */
export class InputStream {
  private readonly stream: ReadStream;

  public constructor({ stream }: {
    /** The underlying stream. */
    stream: ReadStream,
  }) {
    this.stream = stream;
  }

  public [Symbol.dispose](): void {
    dispose(this.stream);
  }

  /**
   * Perform a non-blocking read from the stream.
   * @throws {@link StreamError}
   */
  public read(len: bigint): Uint8Array {
    return this.stream.read(Number(len)) ?? new Uint8Array();
  }

  /**
   * Read bytes from a stream, after blocking until at least one byte can be read.
   * @throws {@link StreamError}
   */
  public blockingRead(len: bigint): MaybePromise<Uint8Array> {
    return this._blockingRead(len);
  }

  private _blockingRead = MaybePromise.coroutine(function* (this: InputStream, len: bigint) {
    const numLen = Number(len);
    let data: Uint8Array | undefined;
    while (!(data = this.stream.read(numLen))?.byteLength) {
      yield this.stream.poll();
    }
    return data;
  }, this);

  /**
   * Skip bytes from a stream. Returns number of bytes skipped.
   * @throws {@link StreamError}
   */
  public skip(len: bigint): bigint {
    return BigInt(this.read(len).byteLength);
  }

  /**
   * Skip bytes from a stream, after blocking until at least one byte can be skipped.
   * @throws {@link StreamError}
   */
  public blockingSkip(len: bigint): MaybePromise<bigint> {
    return MaybePromise.map(this.blockingRead(len), byteLength);
  }

  /**
   * Create a `pollable` which will resolve once either the specified stream has bytes available to read
   * or the other end of the stream has been closed.
   */
  public subscribe(): Pollable {
    return new Pollable({
      pollReady: () => {
        try {
          return !!this.stream.checkRead();
        } catch {
          return true;
        }
      }
    });
  }
}

/** An output bytestream. */
export class OutputStream {
  private readonly stream: WriteStream;

  public constructor({ stream }: {
    /** The underlying stream. */
    stream: WriteStream,
  }) {
    this.stream = stream;
  }

  public [Symbol.dispose](): void {
    dispose(this.stream);
  }

  /**
   * Check readiness for writing. This function never blocks.
   * @throws {@link StreamError}
   */
  public checkWrite(): bigint {
    return BigInt(this.stream.checkWrite());
  }

  /**
   * Perform a write. This function never blocks.
   * @throws {@link StreamError}
   */
  public write(contents: Uint8Array): void {
    this.stream.write(contents);
  }

  /**
   * Perform a write of up to 4096 bytes, and then flush the stream.
   * Block until all of these operations are complete, or an error occurs.
   * @throws {@link StreamError}
   */
  public blockingWriteAndFlush(content: Uint8Array): MaybePromise<void> {
    return this._blockingWriteAndFlush(content);
  }

  private _blockingWriteAndFlush = MaybePromise.coroutine(function* (this: OutputStream, content: Uint8Array) {
    for (let i = 0, chunkLen = 0; i < content.byteLength; i += chunkLen) {
      chunkLen = Math.min(Number(this.checkWrite()), content.byteLength - i, CHUNK_SIZE);
      if (chunkLen > 0) {
        this.write(content.subarray(i, i + chunkLen));
      } else {
        yield this.blockingFlush();
      }
    }
    yield this.blockingFlush();
  }, this);

  /**
   * Request to flush buffered output. This function never blocks.
   * @throws {@link StreamError}
   */
  public flush(): void {
    this.stream.flush();
  }

  /**
   * Request to flush buffered output, and block until flush completes and stream is ready for writing again.
   * @throws {@link StreamError}
   */
  public blockingFlush(): MaybePromise<void> {
    return MaybePromise.map(this.stream.flush(), isFlushed);
  }

  /**
   * Create a `pollable` which will resolve once the output-stream is ready for more writing, or an error has occurred.
   */
  public subscribe(): Pollable {
    return new Pollable({
      pollReady: () => {
        try {
          return this.stream.checkWrite() > 0;
        } catch {
          return true;
        }
      }
    });
  }

  /**
   * Write zeroes to a stream.
   * @throws {@link StreamError}
   */
  public writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  /**
   * Perform a write of up to 4096 zeroes, and then flush the stream.
   * Block until all of these operations are complete, or an error occurs.
   * @throws {@link StreamError}
   */
  public blockingWriteZeroesAndFlush(len: bigint): MaybePromise<void> {
    return this._blockingWriteZeroesAndFlush(len);
  }

  private _blockingWriteZeroesAndFlush = MaybePromise.coroutine(function* (this: OutputStream, len: bigint) {
    const length = Number(len);
    for (let i = 0, chunkLen = 0; i < length; i += chunkLen) {
      chunkLen = Math.min(Number(this.checkWrite()), length - i, CHUNK_SIZE);
      if (chunkLen > 0) {
        this.writeZeroes(BigInt(chunkLen));
      } else {
        yield this.blockingFlush();
      }
    }
    yield this.blockingFlush();
  }, this);

  /**
   * Read from one stream and write to another.
   * @throws {@link StreamError}
   */
  public splice(input: InputStream, len: bigint): bigint {
    let size = this.checkWrite();
    size = size < len ? size : len;
    if (size <= 0n) { return 0n; }
    const data = input.read(size);
    if (data.byteLength) {
      this.write(data);
    }
    return BigInt(data.byteLength);
  }

  /**
   * Read from one stream and write to another, with blocking.
   * @throws {@link StreamError}
   */
  public blockingSplice(input: InputStream, len: bigint): MaybePromise<bigint> {
    return this._blockingSplice(input, len);
  }

  private _blockingSplice = MaybePromise.coroutine(function* (this: OutputStream, input: InputStream, len: bigint) {
    if (len <= 0n) { return 0n; }
    let size;
    while ((size = this.checkWrite()) <= 0n) {
      yield this.stream.flush();
    }
    size = size < len ? size : len;
    const data = yield input.blockingRead(size);
    yield this.blockingWriteAndFlush(data);
    return BigInt(data.byteLength);
  }, this);
}

function byteLength(data: Uint8Array): bigint {
  return BigInt(data.byteLength);
}

function isFlushed(result: boolean): asserts result {
  if (!result) {
    throw new StreamError({ tag: StreamErrorTag.LastOperationFailed, val: new Error('failed to flush write stream') });
  }
}
