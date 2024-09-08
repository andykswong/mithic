import { Worker, workerData } from 'node:worker_threads';
import { BroadcastChannelMessagingService, MessagingClient, MessagingReactor } from '../index.ts';
import { MessageMetadata, type Message, type PeerId } from '../types.ts';
import { getMessageMetadata } from '../utils/message.ts';

const isWorker = !!process.env.MITHIC_WORKER;
const channel = process.env.CHANNEL;
const peerId = process.env.PEER_ID as PeerId;
const peerId2 = process.env.PEER_ID2 as PeerId;

export function runWorker({
  channel = 'message', peerId = 'peer', peerId2 = 'peer2', autoReply, topics = []
}: {
  channel?: string, peerId?: string, peerId2?: string, autoReply?: Message, topics?: string[]
}): [Worker, MessagingClient] {
  const client = new MessagingClient();
  return [new Worker(new URL(import.meta.url), {
    workerData: {
      channel: client.channel,
      topics,
      autoReply,
    },
    env: {
      MITHIC_WORKER: 'true',
      CHANNEL: channel,
      PEER_ID: peerId,
      PEER_ID2: peerId2,
    },
  }), client];
}

if (isWorker) {
  if (workerData.autoReply) {
    const service = new BroadcastChannelMessagingService({ channel, peerId: peerId2 });
    service.subscribe(workerData.topics);
    service.onmessage = (message) => {
      const isRequest = !!getMessageMetadata(message, MessageMetadata.RequestId);
      if (isRequest) {
        service.reply(message, workerData.autoReply);
      }
    };
  }

  new MessagingReactor({
    service: new BroadcastChannelMessagingService({ channel, peerId }),
    ...workerData.channel
  });
}
