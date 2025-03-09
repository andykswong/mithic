import type { MaybePromise } from '@mithic/commons';
import type { Message } from './message.ts';
import type { MessageHandler, PeerId, RequestOptions } from './types.ts';

/** A messaging service adapter. */
export interface MessagingService
  extends MessageProducer, MessageSubscription, Partial<RequestReply>, Partial<PeerPresence> { }

/** A message sending service. */
export interface MessageProducer {
  /** Sends a message. */
  send(topic: string, message: Message): MaybePromise<void>;
}

/** A message subscription service. */
export interface MessageSubscription {
  /** Updates the topic subscriptions for given handler. */
  subscribe(topics: Iterable<string>, handler: MessageHandler): MaybePromise<void>;
}

/** Optional service for request-reply messaging. */
export interface RequestReply {
  /** Sends a request message and waits for reply. */
  request(topic: string, request: Message, options?: RequestOptions): MaybePromise<Message[]>;

  /** Sends a reply to given request message. */
  reply(request: Message, reply: Message): MaybePromise<void>;
}

/** Optional service for messaging peer presence query. */
export interface PeerPresence {
  /** Returns the active subscribers of a topic. */
  listSubscribers(topic: string): MaybePromise<PeerId[]>;
}

/** Synchronous messaging service adapter. */
export interface SyncMessagingService extends MessagingService {
  send(topic: string, message: Message): void;
  subscribe(topics: Iterable<string>, handler: MessageHandler): void;
  request?(topic: string, request: Message, options?: RequestOptions): Message[];
  reply?(request: Message, reply: Message): void;
  listSubscribers?(topic: string): PeerId[];
}
