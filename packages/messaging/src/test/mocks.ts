import { mock, type Mock as _ } from 'node:test';
import type { MessagingService, PeerPresence, RequestReply } from '../service.ts';
import type { Message } from '../types.ts';

const DATA = new Uint8Array([9, 8, 7, 6, 5]);

export function createMessage(topic: string, data: Uint8Array = DATA) {
  return { topic, data, metadata: [] } satisfies Message;
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
