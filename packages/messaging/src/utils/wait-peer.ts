import { AbortError, AbortOptions, equalsOrSameString, StringEquatable } from '@mithic/commons';
import { MessageSubscriptionPeers, MessageSubscriptionState } from '../peer-aware.ts';

/** Interval in milliseconds to wait for next connection check. */
export const CONNECTION_CHECK_INTERVAL_MS = 200;

/** Waits for peer to be connected to specified topic. */
export async function waitForPeer<Peer extends StringEquatable<Peer>>(
  sub: MessageSubscriptionState<Peer>, topic: string, peer: Peer, options?: AbortOptions
): Promise<void> {
  if (await isPeerConnected(sub, topic, peer, options)) {
    return; // return immediately if already connected
  }

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        options?.signal?.throwIfAborted();
      } catch (e) {
        clearInterval(interval);
        return reject(e);
      }

      let subscribed = false;
      for (const subscribedTopic of await sub.topics(options)) {
        if (topic === subscribedTopic) {
          subscribed = true;
          break;
        }
      }
      if (!subscribed) { // no longer subscribed = channel closed
        clearInterval(interval);
        return reject(new AbortError('channel closed'));
      }

      if (await isPeerConnected(sub, topic, peer, options)) {
        clearInterval(interval);
        return resolve();
      }
    }, CONNECTION_CHECK_INTERVAL_MS);
  });
}

/** Checks if peer is connected. */
export async function isPeerConnected<Peer extends StringEquatable<Peer>>(
  sub: MessageSubscriptionPeers<Peer>, topic: string, peer: Peer, options?: AbortOptions
): Promise<boolean> {
  const subscribers = await sub.subscribers({ ...options, topic });
  for (const subscriber of subscribers) {
    if (equalsOrSameString(peer, subscriber)) {
      return true;
    }
  }
  return false;
}
