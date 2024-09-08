import { Io, type IoProvider } from './types.ts';
import { Pollable } from './poll.ts';

const CHUNK_SIZE = 4096;

/** An input bytestream. */
export class InputStream {
  private readonly client: IoProvider;
  private readonly closeOnDispose;
  private _fd;

  public constructor({
    client = Io.provider,
    fd = 0,
    closeOnDispose = true,
  }: {
    client?: IoProvider,
    fd?: number,
    closeOnDispose?: boolean
  }) {
    this.client = client;
    this.closeOnDispose = closeOnDispose;
    this._fd = fd;
  }

  /** Returns the FD of this stream. */
  public get fd(): number {
    return this._fd;
  }

  public [Symbol.dispose](): void {
    if (this.closeOnDispose) {
      // TODO: currently only support stdin which cannot be closed
    }
  }

  /**
   * Perform a non-blocking read from the stream.
   * @throws {@link StreamError}
   */
  public read(len: bigint): Uint8Array {
    return this.client.read(this._fd, Number(len)) ?? new Uint8Array();
  }

  /**
   * Read bytes from a stream, after blocking until at least one byte can be read.
   * @throws {@link StreamError}
   */
  public blockingRead(len: bigint): Uint8Array {
    let data;
    while (!(data = this.client.read(this._fd, Number(len)))?.byteLength) {
      this.client.blockingProcess();
    }
    return data;
  }

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
  public blockingSkip(len: bigint): bigint {
    return BigInt(this.blockingRead(len).byteLength);
  }

  /**
   * Create a `pollable` which will resolve once either the specified stream has bytes available to read
   * or the other end of the stream has been closed.
   */
  public subscribe(): Pollable {
    return new Pollable({ pollReady: () => !!this.client.checkRead(this._fd) });
  }
}

/** An output bytestream. */
export class OutputStream {
  private readonly client: IoProvider;
  private readonly closeOnDispose;
  private _fd;

  public constructor({
    client = Io.provider,
    fd = 1,
    closeOnDispose = true,
  }: {
    client?: IoProvider,
    fd?: number,
    closeOnDispose?: boolean
  }) {
    this.client = client;
    this.closeOnDispose = closeOnDispose;
    this._fd = fd;
  }

  /** Returns the FD of this stream. */
  public get fd(): number {
    return this._fd;
  }

  public [Symbol.dispose](): void {
    if (this.closeOnDispose) {
      // TODO: currently only support stdout/err which cannot be closed
    }
  }

  /**
   * Check readiness for writing. This function never blocks.
   * @throws {@link StreamError}
   */
  public checkWrite(): bigint {
    return BigInt(this.client.checkWrite(this._fd));
  }

  /**
   * Perform a write. This function never blocks.
   * @throws {@link StreamError}
   */
  public write(contents: Uint8Array): void {
    this.client.write(this._fd, contents);
  }

  /**
   * Perform a write of up to 4096 bytes, and then flush the stream.
   * Block until all of these operations are complete, or an error occurs.
   * @throws {@link StreamError}
   */
  public blockingWriteAndFlush(content: Uint8Array): void {
    for (let i = 0, chunkLen = 0; i < content.byteLength; i += chunkLen) {
      chunkLen = Math.min(Number(this.checkWrite()), content.byteLength - i, CHUNK_SIZE);
      if (chunkLen > 0) {
        this.write(content.subarray(i, i + chunkLen));
      } else {
        this.blockingFlush();
      }
    }
    this.blockingFlush();
  }

  /**
   * Request to flush buffered output. This function never blocks.
   * @throws {@link StreamError}
   */
  public flush(): void {
    // noop. flush is automatic
  }

  /**
   * Request to flush buffered output, and block until flush completes and stream is ready for writing again.
   * @throws {@link StreamError}
   */
  public blockingFlush(): void {
    // TODO: this does not actually wait for pending writes to complete
    this.client.flush();
  }

  /**
   * Create a `pollable` which will resolve once the output-stream is ready for more writing, or an error has occurred.
   */
  public subscribe(): Pollable {
    return new Pollable({ pollReady: () => this.checkWrite() > 0n });
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
  public blockingWriteZeroesAndFlush(len: bigint): void {
    const length = Number(len);
    for (let i = 0, chunkLen = 0; i < length; i += chunkLen) {
      chunkLen = Math.min(Number(this.checkWrite()), length - i, CHUNK_SIZE);
      if (chunkLen > 0) {
        this.writeZeroes(BigInt(chunkLen));
      } else {
        this.blockingFlush();
      }
    }
    this.blockingFlush();
  }

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
  public blockingSplice(input: InputStream, len: bigint): bigint {
    if (len <= 0n) { return 0n; }
    let size;
    while ((size = this.checkWrite()) <= 0n) {
      this.client.flush();
    }
    size = size < len ? size : len;
    const data = input.blockingRead(size);
    this.blockingWriteAndFlush(data);
    return BigInt(data.byteLength);
  }
}
