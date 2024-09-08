import type { MaybePromise } from '../async/index.ts';
import type { Codec } from '../codec.ts';
import { dispose, type Startable } from '../lifecycle.ts';
import type { SharedChannelBuffers } from './buffer.ts';
import { SyncMessageChannel } from './message.ts';

/** Reactor to messages from one or more {@link SyncMessageChannel}. */
export class SyncMessageChannelReactor<T> implements Startable, Disposable {
  /** Listener that is called when new message is received. */
  public onmessage: ((channel: SyncMessageChannel<T>, message: T) => MaybePromise<void>) | null = null;
  /** Listener that is called when new channel is added. */
  public onaddchannel: ((channel: SyncMessageChannel<T>) => MaybePromise<void>) | null = null;
  /** Listener that is called when channel is removed. */
  public onremovechannel: ((channel: SyncMessageChannel<T>) => MaybePromise<void>) | null = null;

  private readonly codec: Codec<T>;
  private readonly _channels: SyncMessageChannel<T>[] = [];
  private _started = false;

  public constructor({ codec, onmessage, send, recv, start = true }: SyncMessageChannelReactorOptions<T>) {
    this.codec = codec;
    this.onmessage = onmessage || null;
    if (send && recv) {
      this.addChannel({ send, recv });
    }
    if (start) {
      this.start();
    }
  }

  public [Symbol.dispose](): void {
    for (const channel of this._channels) {
      dispose(channel);
    }
    this._channels.length = 0;
    this._started = false;
  }

  public start(): void {
    this._started = true;
    for (const channel of this._channels) {
      channel.start();
    }
  }

  public get started(): boolean {
    return this._started;
  }

  /** Returns the list of active channels. */
  public * channels(): IterableIterator<SyncMessageChannel<T>> {
    for (const channel of this._channels) {
      yield channel;
    }
  }

  /**
   * Adds a new channel for client, and returns the shared channel buffers to use by the client.
   * Each channel buffer is only valid for single client-reactor connection.
   */
  public addChannel(buffers?: SharedChannelBuffers): SharedChannelBuffers {
    const channel: SyncMessageChannel<T> = new SyncMessageChannel({
      receiver: true,
      codec: this.codec,
      onmessage: (message: T) => this.onmessage?.(channel, message),
      start: this.started,
      ...buffers,
    });
    this._channels.push(channel);
    this.onaddchannel?.(channel);
    return channel.buffers;
  }

  /** Removes a channel by its shared channel buffers. */
  public removeChannel(buffers: SharedChannelBuffers): void {
    for (let i = 0; i < this._channels.length; ++i) {
      const channel = this._channels[i];
      if (sameBuffer(channel.buffers.send, buffers.send) && sameBuffer(channel.buffers.recv, buffers.recv)) {
        this._channels[i] = this._channels[this._channels.length - 1];
        this._channels.pop();
        this.onremovechannel?.(channel);
      }
    }
  }
}

function sameBuffer(a: [SharedArrayBuffer, number?, number?], b: [SharedArrayBuffer, number?, number?]) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}


/** Options for creating {@link SyncMessageChannelReactor}. */
export interface SyncMessageChannelReactorOptions<T> extends Partial<SharedChannelBuffers> {
  /** Message codec. */
  readonly codec: Codec<T>;
  /** Listener that is called when new message is received. */
  readonly onmessage?: (channel: SyncMessageChannel<T>, message: T) => MaybePromise<void>;
  /** Start on construct? */
  readonly start?: boolean;
}
