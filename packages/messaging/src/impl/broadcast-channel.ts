import type { MessageHandler, MessagingService, PeerIdentification, RequestReply } from '../provider/index.ts';
import { MessageMetadata, type Message, type PeerId, type RequestOptions } from '../types.ts';
import { DualBroadcastChannel, isMessage, RequestReplyHelper, setMessageMetadata } from '../utils/index.ts';

const DEFAULT_KEEPALIVE_MS = 1000;
const NUM_KEEPALIVES_TO_WAIT = 3;
const DEFAULT_CHANNEL = 'mithic:messaging';

/** {@link MessagingService} implementation using BroadcastChannel. */
export class BroadcastChannelMessagingService implements MessagingService, RequestReply, PeerIdentification, Disposable {
  /** This instance's peer ID. */
  public readonly peerId?: PeerId;
  public onmessage: MessageHandler | null = null;

  private readonly channel: BroadcastChannel;
  private readonly requestReplyHelper: RequestReplyHelper;
  private readonly now: () => number;
  private readonly keepaliveMs: number;
  private keepAliveTimer = 0;
  private readonly topicSubscribers = new Map<string, Map<string, [peerId: PeerId, lastSeen: number]>>();

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
    this.requestReplyHelper = new RequestReplyHelper({
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

  public send(msg: Message): void {
    const message: BroadcastChannelMessage = {
      type: BroadcastChannelMessageType.Message,
      from: this.peerId,
      msg
    };
    this.channel.postMessage(message);
  }

  public request(request: Message, options?: RequestOptions): Promise<Message[]> {
    return this.requestReplyHelper.request(request, options);
  }

  public reply(request: Message, reply: Message): Promise<void> {
    return this.requestReplyHelper.reply(request, reply);
  }

  public subscribe(topics: string[]): void {
    const topicSet = new Set(topics);
    for (const topic of this.topicSubscribers.keys()) {
      if (!topicSet.has(topic)) {
        this.topicSubscribers.delete(topic);
      }
    }
    for (const topic of topicSet) {
      this.topicSubscribers.set(topic, this.topicSubscribers.get(topic) || new Map());
    }

    if (this.peerId && !this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(this.keepalive, this.keepaliveMs) as unknown as number;
    }
  }

  /** Returns the subscribed topics. */
  public topics(): Iterable<string> {
    return this.topicSubscribers.keys();
  }

  /** Returns the active subscribers of a topic. */
  public subscribers(topic: string): PeerId[] {
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
      topics: [...this.topicSubscribers.keys()],
      from: this.peerId,
    };
    this.channel.postMessage(message);
  }

  private handleMessage = async (event: MessageEvent<unknown>) => {
    const message = event.data as BroadcastChannelMessage;
    if (message.type === BroadcastChannelMessageType.Keepalive) {
      for (const topic of message.topics || []) {
        this.topicSubscribers.get(topic)?.set(`${message.from}`, [message.from, this.now()]);
      }
    } else if (message.type === BroadcastChannelMessageType.Message && isMessage(message.msg)) {
      if (message.from) {
        setMessageMetadata(message.msg, MessageMetadata.From, message.from, true);
      }
      this.requestReplyHelper.accept(message.msg);
      if (this.topicSubscribers.has(message.msg.topic)) {
        try {
          return await this.onmessage?.(message.msg);
        } catch { /** noop */ }
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
  msg: Message,
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
