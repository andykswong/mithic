import { type MaybePromise } from '@mithic/commons';
import { Messaging } from './messaging.ts';
import { type Message } from './types.ts';

/**
 * Sends a message.
 * @throws {@link MessagingError}
 */
export function send(msg: Message): MaybePromise<void> {
  return Messaging.service.send(msg);
}
