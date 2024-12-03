import { delay, Error, type MaybePromise } from '@mithic/commons';
import type { ReadStream, WriteStream } from '../adapters.ts';
import { StreamError } from '../types.ts';
import { appendBuffer, BaseStream, consumeBuffer, StreamState } from './utils.ts';

const BUFFER_SIZE = 4096;

/** Asynchronous {@link ReadStream} backed by Web Streams API. */
export class WebReadStream extends BaseStream implements Disposable, ReadStream {
  private readonly stream: ReadableStream<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer?: Uint8Array;
  private pendingRead?: Promise<void>;

  public constructor(stream: ReadableStream<Uint8Array>) {
    super();
    this.stream = stream;
  }

  public override [Symbol.dispose](): void {
    super[Symbol.dispose]();
    try {
      this.reader?.releaseLock();
    } catch { /* ignore */ }
    this.reader = undefined;
  }

  public read(len: number): Uint8Array | undefined {
    this.checkState();
    let result;
    if (len <= 0) {
      return new Uint8Array();
    }
    if (this.buffer?.length) {
      [this.buffer, result] = consumeBuffer(this.buffer, len);
    } else {
      this.poll(0);
    }
    return result;
  }

  public checkRead(): number {
    this.checkState();
    return this.buffer?.length ?? 0;
  }

  public poll(timeoutMs = Infinity): MaybePromise<boolean> {
    this.checkState();
    if (this.buffer?.length) {
      return true;
    }
    let pendingRead = this.pendingRead;
    if (!pendingRead) {
      pendingRead = this.pendingRead = this.readToBuffer().finally(() => {
        if (pendingRead === this.pendingRead) {
          this.pendingRead = undefined;
        }
      });
    }
    if (timeoutMs <= 0) {
      return false;
    }

    const controller = timeoutMs === Infinity ? undefined : new AbortController();
    const result = pendingRead.then(() => !!this.buffer?.length);
    result.finally(() => { controller?.abort(); });

    return timeoutMs === Infinity ? result :
      Promise.race([result, delay(timeoutMs, controller).then(falsy, falsy)]);
  }

  private async readToBuffer() {
    try {
      const reader = this.getReader();
      const { value, done } = await reader.read();
      if (done) {
        this.close();
      } else {
        this.buffer = appendBuffer(this.buffer, value);
      }
    } catch (cause) {
      this.setError(cause);
    }
  }

  private getReader(): ReadableStreamDefaultReader<Uint8Array> {
    if (!this.reader) {
      this.reader = this.stream.getReader();
    }
    return this.reader;
  }

  protected override get state(): number {
    const state = super.state;
    if (this.buffer?.length) {
      if (state === StreamState.Closed || state === StreamState.Pending) {
        return StreamState.Ready; // has buffered data
      }
    } else if (state === StreamState.Ready) {
      return StreamState.Pending; // no data
    }
    return state;
  }
}

/** Asynchronous {@link WriteStream} backed by Web Streams API. */
export class WebWriteStream extends BaseStream implements Disposable, WriteStream {
  private readonly stream: WritableStream<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private pendingWrite?: Promise<void>;

  public constructor(stream: WritableStream<Uint8Array>) {
    super();
    this.stream = stream;
  }

  public override [Symbol.dispose](): void {
    super[Symbol.dispose]();
    this.writer?.releaseLock();
    this.writer = undefined;
  }

  public write(data: Uint8Array): void {
    const maxSize = this.checkWrite();
    if (data.length > maxSize) {
      throw new StreamError(this.setError(new Error(`cannot write more than ${maxSize} bytes`)));
    }
    const pendingWrite = this.pendingWrite = this.writeToStream(data).finally(() => {
      if (pendingWrite === this.pendingWrite) {
        this.pendingWrite = undefined;
      }
    });
  }

  public checkWrite(): number {
    this.checkState();
    try {
      return (this.getWriter().desiredSize ?? 0) > 0 ? BUFFER_SIZE : 0;
    } catch (cause) {
      throw new StreamError(this.setError(cause));
    }
  }

  public flush(timeoutMs = Infinity): MaybePromise<boolean> {
    this.checkState();
    const pendingWrite = this.pendingWrite;
    if (!pendingWrite) {
      return true;
    }
    if (timeoutMs <= 0) {
      return false;
    }

    const controller = timeoutMs === Infinity ? undefined : new AbortController();
    const result = pendingWrite.then(truthy);
    result.finally(() => { controller?.abort(); });

    return timeoutMs === Infinity ? result :
      Promise.race([result, delay(timeoutMs, controller).then(falsy, falsy)]);
  }

  private async writeToStream(data: Uint8Array) {
    const lastWrite = this.pendingWrite;
    try {
      const writer = this.getWriter();
      await lastWrite;
      await writer.ready;
      await writer.write(data);
    } catch (cause) {
      this.setError(cause);
    }
  }

  private getWriter(): WritableStreamDefaultWriter<Uint8Array> {
    if (!this.writer) {
      this.writer = this.stream.getWriter();
      this.writer.closed.then(falsy, falsy).finally(() => this.close());
    }
    return this.writer;
  }
}

function truthy() {
  return true;
}

function falsy() {
  return false;
}
