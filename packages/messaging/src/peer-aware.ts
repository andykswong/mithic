import { AbortOptions, EventSource, MaybePromise, TypedCustomEvent } from '@mithic/commons';
import { MessageBus, MessageHandler, MessageOptions, MessageValidator, SubscribeOptions } from './messaging.js';

/** A peer-aware {@link MessageBus}. */
export interface PeerAwareMessageBus<OutMsg, Peer = unknown, InMsg = OutMsg>
  extends MessageBus<OutMsg, InMsg, PeerAwareMessageOptions<Peer>>,
  MessageSubscriptionState<Peer>, PeerEventSource<Peer> { }

/** Message subscription state. */
export interface MessageSubscriptionState<Peer = unknown>
  extends MessageSubscriptionTopics, MessageSubscriptionPeers<Peer> {}

/** Peer event source. */
export type PeerEventSource<Peer = unknown> = EventSource<PeerEvents<Peer>>;

/** State of message topic subscription. */
export interface MessageSubscriptionTopics {
  /** Returns the list of subscribed topics for this node. */
  topics(options?: AbortOptions): MaybePromise<Iterable<string>>;
}

/** Peer subscription state of a message topic. */
export interface MessageSubscriptionPeers<Peer = unknown> {
  /** Returns the list of peers that are subscribed to a topic. */
  subscribers(options?: MessageOptions): MaybePromise<Iterable<Peer>>;
}

/** Peer-aware {@link MessageHandler}. */
export type PeerAwareMessageHandler<Msg, Peer> = MessageHandler<Msg, PeerAwareMessageOptions<Peer>>;

/** Peer-aware {@link MessageValidator}. */
export type PeerAwareMessageValidator<Msg, Peer> = MessageValidator<Msg, PeerAwareMessageOptions<Peer>>;

/** Peer-aware {@link SubscribeOptions}. */
export type PeerAwareSubscribeOptions<Msg, Peer> = SubscribeOptions<Msg, PeerAwareMessageOptions<Peer>>;

/** Peer-aware messaging context options. */
export interface PeerAwareMessageOptions<Peer = unknown> extends MessageOptions {
  /** The message's from peer ID. */
  readonly from?: Peer;
}

/** Peer event types of a message bus. */
export type PeerEvents<Peer> = [
  TypedCustomEvent<PeerEvent.Join, PeerChangeData<Peer>>,
  TypedCustomEvent<PeerEvent.Leave, PeerChangeData<Peer>>
];

/** Event names for peer events. */
export enum PeerEvent {
  /** Peer join event. */
  Join = 'join',

  /** Peer leave event. */
  Leave = 'leave',
}

/** Peer change data. */
export interface PeerChangeData<Peer = unknown> {
  /** The target topic. */
  topic?: string;

  /** The concerned peers. */
  peers: Peer[];
}
