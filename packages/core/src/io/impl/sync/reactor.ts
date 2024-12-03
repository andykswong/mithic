import {
  dispose, type SharedChannelBuffers, type Startable, type SyncMessageChannel, SyncMessageChannelReactor
} from '@mithic/commons';
import { getStdin, getStdout, getStderr } from '#io/stdio';
import { type ReadStream, StreamError, StreamErrorTag, WebReadStream, WebWriteStream, type WriteStream } from '../../types.ts';
import { StreamState } from '../utils.ts';
import { IoMessage, IoOp } from './codec.ts';

const DEFAULT_READ_SIZE = 4096;
const STDIN = '/dev/stdin';
const STDOUT = '/dev/stdout';
const STDERR = '/dev/stderr';

/** Reactor to process I/O stream operations. */
export class IoStreamReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<IoMessage>;
  private readonly readSize: number;
  private readonly read: (identifier: string) => [number, ReadStream] | undefined;
  private readonly write: (identifier: string) => [number, WriteStream] | undefined;
  private readonly readStreams = new Map<number, ReadStream>();
  private readonly writeStreams = new Map<number, WriteStream>();

  public constructor({
    send, recv, start = true, readSize = DEFAULT_READ_SIZE,
    read = (identifier) => {
      if (identifier === STDIN) {
        return [0, new WebReadStream(getStdin())];
      }
    },
    write = (identifier) => {
      if (identifier === STDOUT) {
        return [1, new WebWriteStream(getStdout())];
      } else if (identifier === STDERR) {
        return [2, new WebWriteStream(getStderr())];
      }
    },
  }: IoStreamReactorOptions = {}) {
    this.reactor = new SyncMessageChannelReactor({
      codec: IoMessage,
      onmessage: this.handle,
      send, recv, start
    });
    this.readSize = readSize;
    this.read = read;
    this.write = write;
  }

  public [Symbol.dispose](): void {
    dispose(this.reactor);
    for (const stream of this.readStreams.values()) {
      dispose(stream);
    }
    this.readStreams.clear();
    for (const stream of this.writeStreams.values()) {
      dispose(stream);
    }
    this.writeStreams.clear();
  }

  public start(): void {
    this.reactor.start();
  }

  public get started(): boolean {
    return this.reactor.started;
  }

  /**
   * Creates a new channel for client, and returns the shared channel buffers to use by the client.
   * Each channel buffer is only valid for single client-reactor connection.
   */
  public addChannel(buffers?: SharedChannelBuffers): SharedChannelBuffers {
    return this.reactor.addChannel(buffers);
  }

  /** Removes a channel by its shared channel buffers. */
  public removeChannel(buffers: SharedChannelBuffers): void {
    this.reactor.removeChannel(buffers);
  }

  private handle = (channel: SyncMessageChannel<IoMessage>, message: IoMessage) => {
    switch (message.op) {
      case IoOp.Close:
        this.readStreams.delete(message.fd);
        this.writeStreams.delete(message.fd);
        return;
      case IoOp.Ropen:
        return this.handleRopen(channel, message.id);
      case IoOp.Wopen:
        return this.handleWopen(channel, message.id);
      case IoOp.Read:
        return this.handleRead(channel, message.fd);
      case IoOp.Write:
        return this.handleWrite(channel, message.fd, message.content);
    }
  };

  private async handleRopen(channel: SyncMessageChannel<IoMessage>, id: string) {
    const streamPair = this.read(id);
    if (!streamPair) {
      return this.replyError(channel, -1, new StreamError({ tag: StreamErrorTag.Closed }), id);
    }

    const fd = streamPair[0];
    let stream = this.readStreams.get(fd);
    if (stream && stream !== streamPair[1]) {
      dispose(stream);
    }
    stream = streamPair[1];
    this.readStreams.set(fd, stream);

    try {
      return this.replyState(channel, fd, StreamState.Pending, id);
    } catch (e) {
      return this.replyError(channel, fd, e, id);
    }
  }

  private async handleWopen(channel: SyncMessageChannel<IoMessage>, id: string) {
    const streamPair = this.write(id);
    if (!streamPair) {
      return this.replyError(channel, -1, new StreamError({ tag: StreamErrorTag.Closed }), id);
    }

    const fd = streamPair[0];
    let stream = this.writeStreams.get(fd);
    if (stream && stream !== streamPair[1]) {
      dispose(stream);
    }
    stream = streamPair[1];
    this.writeStreams.set(fd, stream);

    try {
      return this.replyState(channel, fd, StreamState.Pending, id);
    } catch (e) {
      return this.replyError(channel, fd, e, id);
    }
  }

  private async handleRead(channel: SyncMessageChannel<IoMessage>, fd: number) {
    const stream = await this.getReadStream(channel, fd);
    if (!stream) { return; }
    try {
      for (; ;) {
        const value = stream.read(this.readSize);
        if (!value?.byteLength) {
          await stream.poll();
          continue;
        }
        return this.replyData(channel, fd, value);
      }
    } catch (e) {
      return this.replyError(channel, fd, e);
    }
  }

  private async handleWrite(channel: SyncMessageChannel<IoMessage>, fd: number, content: Uint8Array) {
    const stream = await this.getWriteStream(channel, fd);
    if (!stream) { return; }
    try {
      // TODO: check write size and flush as needed
      // TODO: add reply to blocking write
      stream.write(content);
    } catch (e) {
      return this.replyError(channel, fd, e);
    }
  }

  private async replyState(channel: SyncMessageChannel<IoMessage>, fd: number, state: number, id?: string) {
    await channel.sendAsync({ op: IoOp.State, fd, state, id });
  }

  private async replyData(channel: SyncMessageChannel<IoMessage>, fd: number, content: Uint8Array) {
    await channel.sendAsync({ op: IoOp.Data, fd, content });
  }

  private replyError(channel: SyncMessageChannel<IoMessage>, fd: number, error: unknown, id?: string) {
    if (error instanceof StreamError && error.payload?.tag === StreamErrorTag.Closed) {
      this.readStreams.delete(fd);
      this.writeStreams.delete(fd);
      return this.replyState(channel, fd, StreamState.Closed, id);
    }
    return this.replyState(channel, fd, StreamState.Error, id);
  }

  private async getReadStream(channel: SyncMessageChannel<IoMessage>, fd: number): Promise<ReadStream | undefined> {
    const stream = this.readStreams.get(fd);
    if (!stream) {
      await this.replyState(channel, fd, StreamState.Closed);
    }
    return stream;
  }

  private async getWriteStream(channel: SyncMessageChannel<IoMessage>, fd: number) {
    const stream = this.writeStreams.get(fd);
    if (!stream) {
      await this.replyState(channel, fd, StreamState.Closed);
    }
    return stream;
  }
}

/** Options for creating {@link IoStreamReactor}. */
export interface IoStreamReactorOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
  /** Max size of data chunk to read at once. */
  readonly readSize?: number;
  /** Function to open a read stream from identifier. */
  readonly read?: (identifier: string) => [fd: number, stream: ReadStream] | undefined;
  /** Function to open a write stream from identifier. */
  readonly write?: (identifier: string) => [fd: number, stream: WriteStream] | undefined;
}
