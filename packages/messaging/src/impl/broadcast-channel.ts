import { Message, type MessageRecord } from '../message.ts';
import type { MessagingService, PeerPresence, RequestReply } from '../service.ts';
import { MessageMetadata, type MessageHandler, type PeerId, type RequestOptions } from '../types.ts';
import { DualBroadcastChannel, isMessageRecord, RequestReplyAdapter } from '../utils/index.ts';

const DEFAULT_KEEPALIVE_MS = 1000;
const NUM_KEEPALIVES_TO_WAIT = 3;
const DEFAULT_CHANNEL = 'mithic:messaging';

/** {@link MessagingService} implementation using BroadcastChannel. */
export class BroadcastChannelMessagingService implements MessagingService, RequestReply, PeerPresence, Disposable {
  /** This instance's peer ID. */
  public readonly peerId?: PeerId;

  private readonly channel: BroadcastChannel;
  private readonly requestReply: RequestReplyAdapter;
  private readonly now: () => number;
  private readonly keepaliveMs: number;
  private keepAliveTimer = 0;
  private readonly topicSubscribers = new Map<string, Map<string, [peerId: PeerId, lastSeen: number]>>();
  private readonly topicHandlers = new Map<string, WeakRef<MessageHandler>[]>();

  public constructor({
    peerId,
    keepaliveMs = DEFAULT_KEEPALIVE_MS,
    now = () => performance.now(),
    randomId = () => crypto.randomUUID(),
    channel = DEFAULT_CHANNEL,
    loopback = true,
  }: BroadcastChannelMessagingOptions = {}) {
    this.now = now;
    this.peerId = peerId;
    this.keepaliveMs = keepaliveMs;
    this.requestReply = new RequestReplyAdapter({
      service: this, now, randomId, replyTopic: peerId ? `reply#${peerId}` : undefined,
    });
    this.channel = loopback ? new DualBroadcastChannel(channel) : new BroadcastChannel(channel);
    this.channel.addEventListener('message', this.handleMessage);
  }

  public [Symbol.dispose](): void {
    this.channel.close();
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = 0;
  }

  public send(topic: string, msg: Message): void {
    const message: BroadcastChannelMessage = {
      type: BroadcastChannelMessageType.Message,
      from: this.peerId,
      topic,
      msg: msg.toRecord(),
    };
    this.channel.postMessage(message);
  }

  public request(topic: string, request: Message, options?: RequestOptions): Promise<Message[]> {
    return this.requestReply.request(topic, request, options);
  }

  public reply(request: Message, reply: Message): void {
    this.requestReply.reply(request, reply);
  }

  public subscribe(topics: Iterable<string>, handler: MessageHandler): void {
    this.unsubscribe(handler);

    const topicSet = new Set(topics);
    for (const topic of topicSet) {
      this.topicSubscribers.set(topic, this.topicSubscribers.get(topic) || new Map());
      const handlers = this.topicHandlers.get(topic) || [];
      handlers.push(new WeakRef(handler));
      this.topicHandlers.set(topic, handlers);
    }

    if (this.peerId && !this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(this.keepalive, this.keepaliveMs) as unknown as number;
    }
  }

  /** Unsubscribes a handler from all topics. */
  public unsubscribe(handler: MessageHandler): void {
    for (const [topic, handlers] of this.topicHandlers.entries()) {
      for (let i = 0; i < handlers.length; ++i) {
        const storedHandler = handlers[i].deref();
        if (!storedHandler || storedHandler === handler) {
          handlers[i] = handlers[handlers.length - 1];
          handlers.pop();
          --i;
        }
      }
      if (handlers.length === 0) {
        this.topicHandlers.delete(topic);
        this.topicSubscribers.delete(topic);
      }
    }
  }

  /** Returns the subscribed topics. */
  public topics(): Iterable<string> {
    return this.topicHandlers.keys();
  }

  /** Returns the active subscribers of a topic. */
  public listSubscribers(topic: string): PeerId[] {
    const results = [];
    const subs = this.topicSubscribers.get(topic);
    if (subs) {
      if (this.peerId) {
        results.push(this.peerId);
      }
      const now = this.now();
      for (const [peerIdStr, [peerId, lastSeen]] of subs) {
        if (lastSeen + this.keepaliveMs * NUM_KEEPALIVES_TO_WAIT < now) { // Drop inactive peers
          subs.delete(peerIdStr);
          continue;
        }
        results.push(peerId);
      }
    }
    return results;
  }

  private keepalive = () => {
    if (!this.peerId) { return; }
    const message: BroadcastChannelMessage = {
      type: BroadcastChannelMessageType.Keepalive,
      topics: [...this.topics()],
      from: this.peerId,
    };
    this.channel.postMessage(message);
  };

  private handleMessage = async (event: MessageEvent<unknown>) => {
    const message = event.data as BroadcastChannelMessage;
    if (message.type === BroadcastChannelMessageType.Keepalive) {
      for (const topic of message.topics || []) {
        this.topicSubscribers.get(topic)?.set(`${message.from}`, [message.from, this.now()]);
      }
    } else if (message.type === BroadcastChannelMessageType.Message && isMessageRecord(message.msg)) {
      const msg = Message.from({ ...message.msg, topic: message.topic });
      if (message.from) {
        msg.addMetadata(MessageMetadata.From, message.from);
      }

      if (this.requestReply.accept(msg)) {
        return;
      }

      const handlers = this.topicHandlers.get(message.topic);
      if (handlers) {
        for (let i = 0; i < handlers.length; ++i) {
          const handler = handlers[i].deref();
          if (!handler) {
            handlers[i] = handlers[handlers.length - 1];
            handlers.pop();
            --i;
            continue;
          }
          try {
            await handler.handle(msg);
          } catch { /** noop */ }
        }
      }
    }
  };
}

/** Options for initializing a {@link BroadcastChannelMessagingService} */
export interface BroadcastChannelMessagingOptions {
  /** Peer ID of this instance. */
  readonly peerId?: PeerId;

  /** Keepalive message interval in milliseconds. Defaults to 1000. */
  readonly keepaliveMs?: number;

  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;

  /** Channel name to use. */
  readonly channel?: string;

  /** Whether to enable loopback of sent messages. */
  readonly loopback?: boolean;

  /** Function to generate random IDs. Defaults to `crypto.getRandomUUID`. */
  readonly randomId?: () => string;
}

/** Internal message format for {@link BroadcastChannelMessagingService}. */
type BroadcastChannelMessage = {
  type: BroadcastChannelMessageType,
  from?: PeerId,
} & ({
  type: typeof BroadcastChannelMessageType.Message,
  topic: string,
  msg: MessageRecord,
} | {
  type: typeof BroadcastChannelMessageType.Keepalive,
  from: PeerId,
  topics: string[],
});

/** Internal message types for {@link BroadcastChannelMessagingService}. */
const BroadcastChannelMessageType = {
  Keepalive: 'keepalive',
  Message: 'message'
} as const;

type BroadcastChannelMessageType = typeof BroadcastChannelMessageType[keyof typeof BroadcastChannelMessageType];
