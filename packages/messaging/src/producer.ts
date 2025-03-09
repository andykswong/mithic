import type { MaybePromise } from '@mithic/commons';
import type { Message } from './message.ts';
import { Messaging } from './messaging.ts';

/**
 * Sends a message.
 * @throws {@link MessagingError}
 */
export function send(topic: string, msg: Message): MaybePromise<void> {
  return Messaging.imports['mithic:messaging/producer'].send(topic, msg);
}
