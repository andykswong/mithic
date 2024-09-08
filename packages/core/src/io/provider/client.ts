import { dispose, Error, type SharedChannelBuffers, type Startable, SyncMessageChannel } from '@mithic/commons';
import { IoMessage, IoOp } from './codec.ts';
import { FD, StreamError, StreamErrorTag, StreamState } from '../types.ts';
import { type IoProvider } from './provider.ts';

const MIN_BUFFER_SIZE = 4096;

/** Provider of I/O stream operations through a remote reactor. Currently only support stdin/out/err. */
export class RemoteIoProvider implements Startable, Disposable, IoProvider {
  private readonly messageChannel: SyncMessageChannel<IoMessage>;
  private readonly readBuffers = new Map<number, Uint8Array>();
  private readonly pendingReads = new Set<number>();
  private readonly states: Map<number, number> = new Map([
    [FD.Stdin, StreamState.Pending],
    [FD.Stdout, StreamState.Pending],
    [FD.Stderr, StreamState.Pending],
  ]);

  public constructor({ send, recv, start }: RemoteIoProviderOptions = {}) {
    this.messageChannel = new SyncMessageChannel({
      receiver: false,
      codec: IoMessage,
      onmessage: this.handle,
      send, recv,
      start
    });
  }

  public [Symbol.dispose](): void {
    dispose(this.messageChannel);
  }

  public start(): void {
    this.messageChannel.start();
  }

  public get started(): boolean {
    return this.messageChannel.started;
  }

  /** Returns the shared channel buffers of the provider. */
  public get channel(): SharedChannelBuffers {
    return this.messageChannel.buffers;
  }

  /** Returns the state of given stream. */
  public state(fd: number): number {
    let state = this.states.get(fd) ?? StreamState.Closed;
    if (state === StreamState.Closed && this.readBuffers.get(fd)?.length) {
      state = StreamState.Ready; // still has data
    }
    return state;
  }

  /** Performs a non-blocking read. */
  public read(fd: number, len: number): Uint8Array | undefined {
    this.checkState(fd);
    const buffer = this.readBuffers.get(fd);
    let result;
    if (buffer && len > 0) {
      result = buffer.subarray(0, Math.min(len, buffer.length));
      this.readBuffers.set(fd, buffer.subarray(result.length));
    }
    if (!buffer?.length) {
      if (this.state(fd) === StreamState.Closed) {
        this.readBuffers.delete(fd);
      } else {
        this.requestRead(fd);
      }
    }
    return result;
  }

  /** Returns the number of readable bytes in the buffer, or -1 if stream is closed. */
  public checkRead(fd: number): number {
    this.process();
    const state = this.state(fd);
    if (state === StreamState.Closed) { return -1; }
    const buffer = this.readBuffers.get(fd);
    const available = buffer?.length ?? 0;
    if (!available) {
      this.requestRead(fd);
    }
    return available;
  }

  /** Performs a non-blocking write. */
  public write(fd: number, data: Uint8Array): void {
    this.checkState(fd);
    if (!this.requestWrite(fd, data)) {
      throw new StreamError({
        tag: StreamErrorTag.LastOperationFailed,
        val: new Error('cannot write more than number of bytes permitted'),
      });
    }
  }

  /** Checks the maximum number of bytes to write. */
  public checkWrite(fd: number): number {
    this.checkState(fd);
    return Math.max(0, this.messageChannel.maxSendSize - IoMessage.headerLength);
  }

  /**
   * Blocking waits until at least 1 incoming message is processed or timeout,
   * and returns the number of messages being processed.
   */
  public blockingProcess(timeoutMs?: number): number {
    return this.messageChannel.blockingProcess(timeoutMs);
  }

  /** Processes incoming I/O responses and returns the number of messages being processed. */
  public process(): number {
    return this.messageChannel.process();
  }

  /** Blocks until send queue is flushed or timeout, and returns if the operation is successful. */
  public flush(timeoutMs?: number): boolean {
    return this.messageChannel.flush(timeoutMs);
  }

  private handle = (message: IoMessage) => {
    switch (message.op) {
      case IoOp.State:
        return this.handleState(message.fd, message.state);
      case IoOp.Data:
        return this.handleData(message.fd, message.content);
    }
  }

  private requestRead(fd: number) {
    if (!this.pendingReads.has(fd) && this.messageChannel.send({ op: IoOp.Read, fd })) {
      this.pendingReads.add(fd);
    }
  }

  private requestWrite(fd: number, content: Uint8Array): boolean {
    return !content.byteLength || this.messageChannel.send({ op: IoOp.Write, fd, content });
  }

  private handleState(fd: number, state: number) {
    if (this.states.get(fd) !== StreamState.Closed) {
      this.states.set(fd, state);
    }
    this.pendingReads.delete(fd);
  }

  private handleData(fd: number, data: Uint8Array) {
    const buffer = this.readBuffers.get(fd);
    let newBuffer;
    if (!buffer) {
      newBuffer = new Uint8Array(new ArrayBuffer(Math.max(MIN_BUFFER_SIZE, data.length)), 0, data.length);
      newBuffer.set(data);
    } else if (buffer.buffer.byteLength - buffer.byteOffset < data.length) {
      const len = buffer.length + data.length;
      newBuffer = new Uint8Array(new ArrayBuffer(Math.max(MIN_BUFFER_SIZE, len)), 0, len);
      newBuffer.set(buffer);
      newBuffer.set(data, buffer.length);
    } else {
      newBuffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length + data.length);
      newBuffer.set(data, buffer.length);
    }
    this.readBuffers.set(fd, newBuffer);
    this.pendingReads.delete(fd);
  }

  private checkState(fd: number) {
    this.process();
    const state = this.state(fd);
    if (state === StreamState.Closed) {
      throw new StreamError({ tag: StreamErrorTag.Closed });
    } else if (state === StreamState.Error) {
      throw new StreamError({
        tag: StreamErrorTag.LastOperationFailed,
        val: new Error(`stream i/o failed, fd=${fd}`)
      });
    }
  }
}

/** Options for creating {@link RemoteIoProvider}. */
export interface RemoteIoProviderOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
}
