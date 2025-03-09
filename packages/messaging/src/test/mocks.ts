import { mock, type Mock as _ } from 'node:test';
import { Message } from '../message.ts';
import type { MessagingService, PeerPresence, RequestReply } from '../service.ts';

const DATA = new Uint8Array([9, 8, 7, 6, 5]);

export function createMessage(topic?: string, data: Uint8Array = DATA) {
  return Message.from({ topic, data, metadata: [] });
}

export function createMockMessagingService(hasRequestReply = true, hasPeerPrescence = true) {
  const requestReply = {
    request: mock.fn(),
    reply: mock.fn()
  } satisfies RequestReply;
  const peerPresence = {
    listSubscribers: mock.fn(),
  } satisfies PeerPresence;

  return {
    send: mock.fn(),
    subscribe: mock.fn(),
    ...(hasRequestReply && requestReply),
    ...(hasPeerPrescence && peerPresence),
  } satisfies MessagingService;
}

export type MockMessagingService = ReturnType<typeof createMockMessagingService>;
