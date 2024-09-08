import { type MaybePromise } from '@mithic/commons';
import { type Message, type PeerId, type RequestOptions } from '../types.ts';

/** A messaging service adapter. */
export interface MessagingService
  extends MessageDispatcher, MessageSubscription, Partial<RequestReply>, Partial<PeerIdentification> { }

/** A message dispatcher service. */
export interface MessageDispatcher {
  /** Sends a message. */
  send(message: Message): MaybePromise<void>;
}

/** A message subscription service. */
export interface MessageSubscription {
  /** Updates subscription to given list of topics. */
  subscribe(topics: string[]): MaybePromise<void>;

  /** The message handler. */
  onmessage: MessageHandler | null;
}

/**
 * Message handler function with optional timeout limit in milliseconds.
 * Throwing an exception other than 'abandoned' may cause the message to be retried.
 */
export type MessageHandler = (message: Message, timeoutMs?: number) => MaybePromise<void>;

/** A request-reply service. */
export interface RequestReply {
  /** Sends a request message and waits for reply. */
  request(request: Message, options?: RequestOptions): MaybePromise<Message[]>;

  /** Sends a reply to given request message. */
  reply(request: Message, reply: Message): MaybePromise<void>;
}

/** Optional service for peer-to-peer messaging peer identification. */
export interface PeerIdentification {
  /** Returns the active subscribers of a topic. */
  subscribers(topic: string): MaybePromise<PeerId[]>;
}
