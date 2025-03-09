import type { MaybePromise } from '@mithic/commons';
import type { Message } from './message.ts';
import { Messaging } from './messaging.ts';
import type { RequestOptions } from './types.ts';

/**
 * Performs a blocking request with an optional set of request options.
 * This returns all replies received up until timeout or the configured set of expected replies.
 * @throws {@link MessagingError}
 */
export function request(topic: string, request: Message, options?: RequestOptions): MaybePromise<Message[]> {
  return Messaging.imports['mithic:messaging/request-reply'].request(topic, request, options);
}

/**
 * Sends a reply message for given request.
 * @throws {@link MessagingError}
 */
export function reply(request: Message, reply: Message): MaybePromise<void> {
  return Messaging.imports['mithic:messaging/request-reply'].reply(request, reply);
}
