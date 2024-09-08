import { Messaging } from './provider/index.ts';
import { type PeerId } from './types.ts';

/**
 * Get the list of known `peer-id` that subscribed to given topic.
 * @throws {@link MessagingError}
 */
export function listSubscribers(topic: string): PeerId[] {
  return Messaging.provider.subscribers(topic);
}
