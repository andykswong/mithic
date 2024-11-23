import { type MaybePromise } from '@mithic/commons';
import { IncomingHandlerFQN, type MessagingGuest } from './types.ts';
import { RoutingMessagingService } from './impl/index.ts';

let service: RoutingMessagingService;

/** The messaging module. */
export const Messaging = {
  /** The messaging service. */
  get service(): RoutingMessagingService {
    if (!service) {
      service = new RoutingMessagingService();
    }
    return service;
  },
  set service(value: RoutingMessagingService) {
    service = value;
  },

  /** Subscribes a messaging guest component to provider. */
  subscribe(topics: Iterable<string>, guest: MessagingGuest): MaybePromise<void> {
    const handler = guest[IncomingHandlerFQN];
    if (handler) {
      return this.service.subscribe(topics, handler);
    }
  }
};
