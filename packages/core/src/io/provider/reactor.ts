import {
  dispose, type SharedChannelBuffers, type Startable, type SyncMessageChannel, SyncMessageChannelReactor
} from '@mithic/commons';
import { getStdin, getStdout, getStderr } from '#io/stdio';
import { IoMessage, IoOp } from './codec.ts';
import { FD, StreamState } from '../types.ts';

/** Reactor to process I/O stream operations. Currently only support stdin/out/err. */
export class IoReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<IoMessage>;
  private readonly readStreams = new Map<number, ReadableStreamState>();
  private readonly writeStreams = new Map<number, WritableStreamState>();

  public constructor({
    stdin, stdout, stderr,
    send, recv,
    start = true,
  }: IoReactorOptions = {}) {
    this.setReadStream(FD.Stdin, stdin || getStdin());
    this.setWriteStream(FD.Stdout, stdout || getStdout());
    this.setWriteStream(FD.Stderr, stderr || getStderr());
    this.reactor = new SyncMessageChannelReactor({
      codec: IoMessage,
      onmessage: this.handle,
      send, recv, start
    });
  }

  public [Symbol.dispose](): void {
    dispose(this.reactor);
    for (const stream of this.readStreams.values()) {
      stream.reader?.releaseLock();
    }
    this.readStreams.clear();
    for (const stream of this.writeStreams.values()) {
      stream.writer?.releaseLock();
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
      case IoOp.Read:
        return this.handleRead(channel, message.fd);
      case IoOp.Write:
        // TODO: consider to use task queue to limit concurrent writes (reads are already limited on client side)
        // TODO: add reply to blocking write
        return this.handleWrite(channel, message.fd, message.content);
    }
  };

  private async handleRead(channel: SyncMessageChannel<IoMessage>, fd: number) {
    const stream = await this.getReadStream(channel, fd);
    if (!stream) { return; }
    try {
      const { value, done } = await stream.reader.read();
      if (done) {
        return this.replyState(channel, fd, StreamState.Closed);
      }
      return this.replyData(channel, fd, value);
    } catch {
      return this.replyState(channel, fd, StreamState.Error);
    }
  }

  private async handleWrite(channel: SyncMessageChannel<IoMessage>, fd: number, content: Uint8Array) {
    const stream = await this.getWriteStream(channel, fd);
    if (!stream) { return; }
    try {
      await stream.writer.ready;
      await stream.writer.write(content);
    } catch {
      return this.replyState(channel, fd, StreamState.Error);
    }
  }

  private async replyState(channel: SyncMessageChannel<IoMessage>, fd: number, state: number) {
    await channel.sendAsync({ op: IoOp.State, fd, state });
  }

  private async replyData(channel: SyncMessageChannel<IoMessage>, fd: number, content: Uint8Array) {
    await channel.sendAsync({ op: IoOp.Data, fd, content });
  }

  private async getReadStream(channel: SyncMessageChannel<IoMessage>, fd: number) {
    const stream = this.readStreams.get(fd);
    if (!stream) {
      return this.replyState(channel, fd, StreamState.Closed);
    }
    if (!stream.reader) {
      try {
        stream.reader = stream.stream.getReader();
      } catch {
        return this.replyState(channel, fd, StreamState.Error);
      }
    }
    return stream as Required<ReadableStreamState>;
  }

  private async getWriteStream(channel: SyncMessageChannel<IoMessage>, fd: number) {
    const stream = this.writeStreams.get(fd);
    if (!stream) {
      return this.replyState(channel, fd, StreamState.Closed);
    }
    if (!stream.writer) {
      try {
        stream.writer = stream.stream.getWriter();
      } catch {
        return this.replyState(channel, fd, StreamState.Error);
      }
    }
    return stream as Required<WritableStreamState>;
  }

  private setReadStream(fd: number, stream: ReadableStream<Uint8Array>): void {
    if (!stream.locked) {
      this.readStreams.set(fd, { stream });
    }
  }

  private setWriteStream(fd: number, stream: WritableStream<Uint8Array>): void {
    if (!stream.locked) {
      this.writeStreams.set(fd, { stream });
    }
  }
}

/** Options for creating {@link IoReactor}. */
export interface IoReactorOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
  /** stdin stream. */
  readonly stdin?: ReadableStream<Uint8Array>;
  /** stdout stream. */
  readonly stdout?: WritableStream<Uint8Array>;
  /** stderr stream. */
  readonly stderr?: WritableStream<Uint8Array>;
}

type ReadableStreamState = {
  stream: ReadableStream<Uint8Array>,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
};

type WritableStreamState = {
  stream: WritableStream<Uint8Array>,
  writer?: WritableStreamDefaultWriter<Uint8Array>,
};
