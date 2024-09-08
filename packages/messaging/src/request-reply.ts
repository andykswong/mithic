import { Messaging } from './provider/index.ts';
import { type Message, type RequestOptions } from './types.ts';

/**
 * Performs a blocking request with an optional set of request options.
 * This returns all replies received up until timeout or the configured set of expected replies.
 * @throws {@link MessagingError}
 */
export function request(request: Message, options?: RequestOptions): Message[] {
  return Messaging.provider.request(request, options);
}

/**
 * Sends a reply message for given request.
 * @throws {@link MessagingError}
 */
export function reply(request: Message, reply: Message): void {
  Messaging.provider.reply(request, reply);
}
