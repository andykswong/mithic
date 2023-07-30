import { AbortOptions, Closeable, EventSource, MaybePromise, TypedCustomEvent } from '@mithic/commons';

/**
 * A generalized publish/subscribe service,
 * which can represent an actual pub/sub service, message queue or any producer-consumer model.
 */
export interface PubSub<Msg = Uint8Array, Peer = unknown> extends Closeable {
  /**
   * Subscribes to given `topic`.
   * Multiple `subscribe` calls on the same topic will replace existing handler.
   */
  subscribe(
    topic: string,
    handler: MessageHandler<PubSubMessage<Msg, Peer>>,
    options?: SubscribeOptions<PubSubMessage<Msg, Peer>>
  ): MaybePromise<void>;

  /** Unsubscribes from given `topic`. */
  unsubscribe(topic: string, options?: AbortOptions): MaybePromise<void>;

  /** Publishes a message to given `topic`. */
  publish(topic: string, message: Msg, options?: AbortOptions): MaybePromise<void>;

  /** Returns the list of known topics. */
  topics(options?: AbortOptions): MaybePromise<Iterable<string>>;
}

/**
 * A peer-aware {@link PubSub}.
 */
export interface PeerAwarePubSub<Msg = Uint8Array, Peer = unknown>
  extends Closeable, EventSource<PubSubPeerEvents<Peer>>, PubSub<Msg, Peer>, PubSubPeerState<Peer> { }

/** Peer subscription state queries for {@link PeerAwarePubSub}. */
export interface PubSubPeerState<Peer = unknown> {
  /** Returns the list of known topics. */
  topics(options?: AbortOptions): MaybePromise<Iterable<string>>;

  /** Returns the list of peers that are subscribed to one topic. */
  subscribers(topic: string, options?: AbortOptions): MaybePromise<Iterable<Peer>>;
}

/** Options for {@link PubSub#subscribe}. */
export interface SubscribeOptions<Msg extends PubSubMessage> extends AbortOptions {
  /** Message validator for the topic. */
  validator?: MessageValidator<Msg>;
}

/**
 * Handler function of a {@link PubSub} topic message.
 * Throwing an exception will cause the message to be retried.
 */
export type MessageHandler<Msg> = (message: Msg) => MaybePromise<void>;

/** {@link PubSub} topic message validator function. */
export type MessageValidator<Msg> = (message: Msg) => MaybePromise<MessageValidatorResult>;

/** {@link PubSub} message validation result. */
export enum MessageValidatorResult {
  /**
   * The message is considered valid, and it should be delivered and forwarded to the network.
   */
  Accept = 'accept',
  /**
   * The message is neither delivered nor forwarded to the network.
   */
  Ignore = 'ignore',
  /**
   * The message is considered invalid, and it should be rejected.
   */
  Reject = 'reject'
}

/** {@link PubSub} message. */
export interface PubSubMessage<T = unknown, Peer = unknown> {
  /** The message's target topic. */
  topic: string;

  /** The message payload. */
  data: T;

  /** The peer that sends the message. */
  from?: Peer;
}

/** {@link PeerAwarePubSub} peer change data. */
export interface PubSubPeerChangeData<Peer = unknown> {
  /** The message's target topic. */
  topic: string;

  /** The concerned peers. */
  peers: Peer[];
}

/** Event names for {@link PeerAwarePubSub}. */
export enum PubSubPeerEvent {
  /** Peer join event. */
  Join = 'join',

  /** Peer leave event. */
  Leave = 'leave',
}

/** Event types for {@link PeerAwarePubSub}. */
export type PubSubPeerEvents<Peer> = [
  TypedCustomEvent<PubSubPeerEvent.Join, PubSubPeerChangeData<Peer>>,
  TypedCustomEvent<PubSubPeerEvent.Leave, PubSubPeerChangeData<Peer>>
];
