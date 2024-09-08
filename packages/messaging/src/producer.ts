import { Messaging } from './provider/index.ts';
import { type Message } from './types.ts';

/**
 * Sends a message.
 * @throws {@link MessagingError}
 */
export function send(msg: Message): void {
  Messaging.provider.send(msg);
}
