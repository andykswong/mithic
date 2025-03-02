import { dispose, Error, type SharedChannelBuffers, type Startable, SyncMessageChannel } from '@mithic/commons';
import type { SyncReadStream, SyncWriteStream } from '../../adapters.ts';
import { appendBuffer, BaseStream, consumeBuffer, StreamState } from '../utils.ts';
import { StreamError, StreamErrorTag, type StreamErrorPayload } from '../../types.ts';
import { IoMessage, IoOp } from './codec.ts';

const ABORT_ERROR_NAME = 'AbortError';
const DEFAULT_TIMEOUT_MS = 5000;
const TICK_MS = 1000;

/** Provider of synchronous read/write streams that are proxied through a remote reactor. */
export class IoStreamClientProvider implements Startable, Disposable {
  private readonly messageChannel: SyncMessageChannel<IoMessage>;
  private readonly fds: Map<string, number> = new Map();
  private readonly rstreams: Map<number, ReadStreamClient> = new Map();
  private readonly wstreams: Map<number, WriteStreamClient> = new Map();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  public constructor({
    send, recv, start,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => performance.now(),
  }: IoStreamClientProviderOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
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

  /** Opens a {@link ReadStream} by identifier. */
  public openReadStream(identifier: string): SyncReadStream {
    let stream = this.rstreams.get(this.fds.get(identifier) ?? -StreamState.Closed);
    if (stream) {
      return stream;
    }

    const start = this.now();
    request(this.messageChannel, { op: IoOp.Ropen, id: identifier }, this.timeoutMs, this.now, start);
    while (!this.fds.has(identifier)) {
      this.messageChannel.blockingProcess(nextTick(this.timeoutMs, this.now, start));
    }

    const fd = this.fds.get(identifier) ?? -StreamState.Closed;
    if (fd < 0) {
      throw new StreamError({ tag: StreamErrorTag.Closed });
    }

    stream = new ReadStreamClient(
      fd,
      this.messageChannel,
      this.now,
      this.timeoutMs,
      () => {
        this.fds.delete(identifier);
        this.rstreams.delete(fd);
      },
    );
    this.rstreams.set(stream.fd, stream);

    return stream;
  }

  /** Opens a {@link WriteStream} by identifier. */
  public openWriteStream(identifier: string): SyncWriteStream {
    let stream = this.wstreams.get(this.fds.get(identifier) ?? -StreamState.Closed);
    if (stream) {
      return stream;
    }

    const start = this.now();
    request(this.messageChannel, { op: IoOp.Wopen, id: identifier }, this.timeoutMs, this.now, start);
    while (!this.fds.has(identifier)) {
      this.messageChannel.blockingProcess(nextTick(this.timeoutMs, this.now, start));
    }

    const fd = this.fds.get(identifier) ?? -StreamState.Closed;
    if (fd < 0) {
      throw new StreamError({ tag: StreamErrorTag.Closed });
    }

    stream = new WriteStreamClient(
      fd,
      this.messageChannel,
      this.now,
      this.timeoutMs,
      () => {
        this.fds.delete(identifier);
        this.rstreams.delete(fd);
      },
    );
    this.wstreams.set(stream.fd, stream);

    return stream;
  }

  private handle = (message: IoMessage) => {
    switch (message.op) {
      case IoOp.State:
        if (message.id) {
          return this.handleOpen(message.id, message.fd, message.state);
        }
        return this.handleState(message.fd, message.state);
      case IoOp.Data:
        return this.handleData(message.fd, message.content);
    }
  };

  private handleOpen(id: string, fd: number, state: number) {
    if (state === StreamState.Closed || state === StreamState.Error) {
      this.fds.set(id, -state);
    } else {
      this.fds.set(id, fd);
    }
  }

  private handleState(fd: number, state: number) {
    const stream = this.rstreams.get(fd) ?? this.wstreams.get(fd);
    if (!stream) { return; }
    if (state === StreamState.Closed) {
      stream.close();
    } else if (state === StreamState.Error) {
      stream.setError(new Error(`stream i/o failed, fd=${fd}`));
    }
  }

  private handleData(fd: number, data: Uint8Array) {
    this.rstreams.get(fd)?.push(data);
  }
}

/** Options for creating {@link IoStreamClientProvider}. */
export interface IoStreamClientProviderOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
  /** Global operation timeout limit in milliseconds. Defaults to 5s. */
  readonly timeoutMs?: number;
  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;
}

class ReadStreamClient extends BaseStream implements SyncReadStream {
  public readonly fd: number;

  private readonly messageChannel: SyncMessageChannel<IoMessage>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly dispose?: () => void;
  private buffer?: Uint8Array;
  private pendingRead = false;

  public constructor(
    fd: number,
    messageChannel: SyncMessageChannel<IoMessage>,
    now: () => number,
    timeoutMs: number,
    dispose?: () => void,
  ) {
    super();
    this.fd = fd;
    this.messageChannel = messageChannel;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.dispose = dispose;
  }

  public override[Symbol.dispose]() {
    super[Symbol.dispose]();
    request(this.messageChannel, { op: IoOp.Close, fd: this.fd }, this.timeoutMs, this.now, this.now());
    this.dispose?.();
  }

  public read(len: number) {
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

  public checkRead() {
    this.checkState();
    return this.buffer?.length ?? 0;
  }

  public poll(timeoutMs = Infinity) {
    this.checkState();
    if (this.buffer?.length) {
      return true;
    }
    if (!this.pendingRead) {
      if (this.messageChannel.send({ op: IoOp.Read, fd: this.fd })) {
        this.pendingRead = true;
      } else {
        return false;
      }
    }
    const processed = timeoutMs <= 0 ?
      this.messageChannel.process() :
      this.messageChannel.blockingProcess(timeoutMs);
    return processed > 0;
  }

  public push(data: Uint8Array) {
    if (data.length) {
      this.buffer = appendBuffer(this.buffer, data);
      this.pendingRead = false;
    }
  }

  public override close() {
    super.close();
  }

  public override setError(cause?: unknown) {
    return super.setError(cause);
  }
}

class WriteStreamClient extends BaseStream implements SyncWriteStream {
  public readonly fd: number;

  private readonly messageChannel: SyncMessageChannel<IoMessage>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly dispose?: () => void;

  public constructor(
    fd: number,
    messageChannel: SyncMessageChannel<IoMessage>,
    now: () => number,
    timeoutMs: number,
    dispose?: () => void,
  ) {
    super();
    this.fd = fd;
    this.messageChannel = messageChannel;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.dispose = dispose;
  }

  public override[Symbol.dispose]() {
    super[Symbol.dispose]();
    request(this.messageChannel, { op: IoOp.Close, fd: this.fd }, this.timeoutMs, this.now, this.now());
    this.dispose?.();
  }

  public write(content: Uint8Array) {
    this.checkState();
    if (content.byteLength && !this.messageChannel.send({ op: IoOp.Write, fd: this.fd, content })) {
      throw new StreamError({
        tag: StreamErrorTag.LastOperationFailed,
        val: new Error(`cannot write more than ${this.checkWrite()} bytes`),
      });
    }
  }

  public checkWrite(): number {
    this.checkState();
    return Math.max(0, this.messageChannel.maxSendSize - IoMessage.headerLength);
  }

  public flush(timeoutMs = Infinity): boolean {
    return this.messageChannel.flush(timeoutMs);
  }

  public override close() {
    super.close();
  }

  public override setError(cause?: unknown) {
    return super.setError(cause);
  }
}

function request(
  channel: SyncMessageChannel<IoMessage>, msg: IoMessage, timeoutMs: number, now: () => number, start: number,
) {
  while (!channel.send(msg)) {
    channel.flush(nextTick(timeoutMs, now, start));
  }
}

function assert(cond: unknown, error: StreamErrorPayload): asserts cond {
  if (!cond) { throw new StreamError(error); }
}

function nextTick(timeoutMs: number, now: () => number, start = now()): number {
  const timeRemaining = timeoutMs - (now() - start);
  assert(timeRemaining > 0, {
    tag: StreamErrorTag.LastOperationFailed,
    val: new Error('timout', { name: ABORT_ERROR_NAME })
  });
  return Math.min(TICK_MS, timeRemaining);
}
