import { type MaybePromise } from '@mithic/commons';
import { type MessageHandler, type Message, type PeerId, type RequestOptions } from './types.ts';

/** A messaging service adapter. */
export interface MessagingService
  extends MessageDispatcher, MessageSubscription, Partial<RequestReply>, Partial<PeerPresence> { }

/** A message dispatcher service. */
export interface MessageDispatcher {
  /** Sends a message. */
  send(message: Message): MaybePromise<void>;
}

/** A message subscription service. */
export interface MessageSubscription {
  /** Updates the topic subscriptions for given handler. */
  subscribe(topics: Iterable<string>, handler: MessageHandler): MaybePromise<void>;
}

/** Optional service for request-reply messaging. */
export interface RequestReply {
  /** Sends a request message and waits for reply. */
  request(request: Message, options?: RequestOptions): MaybePromise<Message[]>;

  /** Sends a reply to given request message. */
  reply(request: Message, reply: Message): MaybePromise<void>;
}

/** Optional service for messaging peer presence query. */
export interface PeerPresence {
  /** Returns the active subscribers of a topic. */
  listSubscribers(topic: string): MaybePromise<PeerId[]>;
}
