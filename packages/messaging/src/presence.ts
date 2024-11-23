import { type MaybePromise } from '@mithic/commons';
import { Messaging } from './messaging.ts';
import { type PeerId } from './types.ts';

/**
 * Get the list of known `peer-id` that subscribed to given topic.
 * @throws {@link MessagingError}
 */
export function listSubscribers(topic: string): MaybePromise<PeerId[]> {
  return Messaging.imports['mithic:messaging/presence'].listSubscribers(topic);
}
