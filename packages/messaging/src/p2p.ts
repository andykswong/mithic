import { AbortOptions, MaybePromise, Startable } from '@mithic/commons';
import { MessageHandler } from './pubsub.js';

/** Peer-to-peer message publishing channel. */
export interface PeerChannel<Msg = Uint8Array, Peer = unknown> extends Startable {
  /** The ID of this channel. */
  readonly id: string;

  /** This peer. */
  readonly self: Peer;

  /** The other peer of this channel. */
  readonly peer: Peer;

  /** Returns if the channel connection is established. */
  readonly started: boolean;

  /** Attempts to start the channel and wait for the peer to join. */
  start(options?: PeerChannelOptions<PeerMessage<Msg, Peer>>): MaybePromise<void>;

  /** Publishes a message to peer. */
  publish(message: Msg, options?: AbortOptions): MaybePromise<void>;
}

/** Options for {@link PeerChannel#start}. */
export interface PeerChannelOptions<Msg> extends AbortOptions {
  /** Message handler. */
  handler?: MessageHandler<Msg>;
}

/** {@link PeerChannel} message. */
export interface PeerMessage<T = unknown, Peer = unknown> {
  /** The message payload. */
  data: T;

  /** The peer that sends the message. */
  from: Peer;
}
