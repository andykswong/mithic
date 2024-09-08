import { Messaging } from './provider/index.ts';

/**
 * Subscribe to given topics.
 * @throws {@link MessagingError}
 */
export function subscribe(topics: string[]): void {
  Messaging.provider.subscribe(topics);
}
