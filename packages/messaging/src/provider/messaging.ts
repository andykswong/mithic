import { IncomingHandlerFQN, type MessagingGuest } from '../types.ts';
import { MessagingClient } from './client.ts';

let provider: MessagingClient;

/** The messaging module. */
export const Messaging = {
  /** The messaging client/provider. */
  get provider(): MessagingClient {
    if (!provider) {
      provider = new MessagingClient();
    }
    return provider;
  },
  set provider(value: MessagingClient) {
    provider = value;
  },

  /** Sets handler of a messaging guest component to provider. */
  setHandler(guest: MessagingGuest): void {
    const handler = guest[IncomingHandlerFQN];
    if (handler) {
      this.provider.onmessage = (msg) => handler.handle(msg);
    }
  }
};
