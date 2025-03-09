import type { MaybePromise } from '@mithic/commons';
import type { MessageProducer, MessagingService, PeerPresence, RequestReply } from './service.ts';
import { IncomingHandlerFQN, type MessagingGuest } from './types.ts';
import { BroadcastChannelMessagingService } from './impl/index.ts';
import { unsupported } from './utils/index.ts';

let service: MessagingService;

/** Messaging module. */
export const Messaging = {
  /** The underlying messaging service. */
  get service(): MessagingService {
    if (!service) {
      service = new BroadcastChannelMessagingService();
    }
    return service;
  },
  set service(value: MessagingService) {
    service = value;
  },

  /** Messaging module imports. */
  imports: {
    'mithic:messaging/producer': {
      send: (topic, message) => service.send(topic, message),
    } satisfies MessageProducer,
    'mithic:messaging/request-reply': {
      request: (topic, request, options) => service.request?.(topic, request, options) ?? unsupported(),
      reply: (request, reply) => service.reply ? service.reply(request, reply) : unsupported(),
    } satisfies RequestReply,
    'mithic:messaging/presence': {
      listSubscribers: (topic) => service.listSubscribers?.(topic) ?? unsupported(),
    } satisfies PeerPresence,
  },

  /** Subscribes a messaging guest component to provider. */
  subscribe(topics: Iterable<string>, guest: MessagingGuest): MaybePromise<void> {
    const handler = guest[IncomingHandlerFQN];
    if (handler) {
      return this.service.subscribe(topics, handler);
    }
  },
};
