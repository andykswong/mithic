import { StringEquatable, TypedCustomEvent, TypedEventTarget, createEvent } from '@mithic/commons';
import {
  MessageHandler, MessageValidator, MessageValidatorResult, PeerAwarePubSub, PubSubMessage, PubSubPeerChangeData,
  PubSubPeerEvent, PubSubPeerEvents, SubscribeOptions,
} from '../pubsub.js';
import { DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS, PubSubPeerMonitor } from './monitor.js';

/** Default keepalive ping interval for {@link BroadcastChannelPubSub} in milliseconds. */
export const DEFAULT_BROADCAST_CHANNEL_PUBSUB_KEEPALIVE_MS = 1000;
/** Number of keepalive intervals to wait for before considering a peer as dropped. */
const NUM_KEEPALIVES_TO_WAIT = 3;

/** {@link PubSub} implementation using browser BroadcastChannel. */
export class BroadcastChannelPubSub<Msg = Uint8Array, PeerId extends StringEquatable = string>
  extends TypedEventTarget<PubSubPeerEvents<PeerId>>
  implements PeerAwarePubSub<Msg, PeerId>
{
  /** This peer's ID. */
  public readonly peerId: PeerId;
  private readonly keepaliveMs: number;
  private readonly peerRefreshMs: number;
  private readonly now: () => number;
  private readonly channelFactory: new (name: string) => BroadcastChannel;

  private readonly topicChannels = new Map<string, BroadcastChannel>();
  private readonly topicSubscribers = new Map<string, Map<string, [peerId: PeerId, lastSeen: number]>>();
  private readonly topicHandlers = new Map<string, MessageHandler<PubSubMessage<Msg, PeerId>>>();
  private readonly topicValidators = new Map<string, MessageValidator<PubSubMessage<Msg, PeerId>>>();
  private peerMonitor?: PubSubPeerMonitor<PeerId>;
  private keepAliveTimer = 0;

  public constructor({
    peerId,
    keepaliveMs = DEFAULT_BROADCAST_CHANNEL_PUBSUB_KEEPALIVE_MS,
    monitorPeers = DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS,
    now = Date.now,
    channelFactory = BroadcastChannel,
  }: BroadcastChannelPubSubOptions<PeerId>) {
    super();
    this.peerId = peerId;
    this.keepaliveMs = keepaliveMs;
    this.peerRefreshMs = monitorPeers && monitorPeers > 0 ? monitorPeers : 0;
    this.now = now;
    this.channelFactory = channelFactory;
  }

  public close(): void {
    for (const topic of this.topicChannels.keys()) {
      this.unsubscribe(topic);
    }
  }

  public subscribe(
    topic: string,
    handler: MessageHandler<PubSubMessage<Msg, PeerId>>,
    options?: SubscribeOptions<PubSubMessage<Msg, PeerId>>
  ): void {
    this.topicHandlers.set(topic, handler);
    options?.validator && this.topicValidators.set(topic, options.validator);

    if (this.topicChannels.has(topic)) {
      return;
    }

    const channel = new this.channelFactory(topic);
    channel.addEventListener('message', (event) => this.onMessage(topic, event));
    this.topicChannels.set(topic, channel);
    this.topicSubscribers.set(topic, new Map());

    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(this.keepalive, this.keepaliveMs) as unknown as number;
    }

    if (this.peerRefreshMs && !this.peerMonitor?.started) {
      this.peerMonitor = this.peerMonitor || new PubSubPeerMonitor(this, this.peerRefreshMs, false);
      this.peerMonitor.addEventListener(PubSubPeerEvent.Join, this.onPeerJoin);
      this.peerMonitor.addEventListener(PubSubPeerEvent.Leave, this.onPeerLeave);
      this.peerMonitor.start();
    }
  }

  public unsubscribe(topic: string): void {
    const channel = this.topicChannels.get(topic);
    if (!channel) {
      return;
    }

    channel.close();
    this.topicChannels.delete(topic);
    this.topicSubscribers.delete(topic);
    this.topicHandlers.delete(topic);
    this.topicValidators.delete(topic);

    if (!this.topicChannels.size) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = 0;

      if (this.peerMonitor) {
        this.peerMonitor.removeEventListener(PubSubPeerEvent.Join, this.onPeerJoin);
        this.peerMonitor.removeEventListener(PubSubPeerEvent.Leave, this.onPeerLeave);
        this.peerMonitor.close();
      }
    }
  }

  public publish(topic: string, data: Msg): void {
    const channel = this.topicChannels.get(topic);
    if (channel) {
      const message: BroadcastChannelPubSubMessage<Msg, PeerId> = {
        type: BroadcastChannelPubSubMessageType.Message,
        from: this.peerId,
        data
      };
      channel.postMessage(message);
    }
  }

  public topics(): Iterable<string> {
    return this.topicChannels.keys();
  }

  public * subscribers(topic: string): Iterable<PeerId> {
    const subs = this.topicSubscribers.get(topic);
    if (subs) {
      const now = this.now();
      for (const [peerIdStr, [peerId, lastSeen]] of subs) {
        if (lastSeen + this.keepaliveMs * NUM_KEEPALIVES_TO_WAIT < now) { // Drop inactive peers
          subs.delete(peerIdStr);
          continue;
        }
        yield peerId;
      }
    }
  }

  private onMessage(topic: string, event: MessageEvent<unknown>) {
    const message = event.data as BroadcastChannelPubSubMessage<Msg, PeerId>;

    if (
      !message.from ||
      (
        message.type !== BroadcastChannelPubSubMessageType.Message &&
        message.type !== BroadcastChannelPubSubMessageType.Keepalive
      )
    ) {
      return;
    }

    // Update last seen time of peer
    this.topicSubscribers.get(topic)?.set(`${message.from}`, [message.from, this.now()]);

    if (message.type === BroadcastChannelPubSubMessageType.Keepalive || message.data == void 0) {
      return;
    }

    const pubsubMessage: PubSubMessage<Msg, PeerId> = { topic, data: message.data, from: message.from };

    // Dispatch message event if valid
    const handler = this.topicHandlers.get(topic);
    const validator = this.topicValidators.get(topic);
    if (handler && (!validator || validator(pubsubMessage) === MessageValidatorResult.Accept)) {
      handler(pubsubMessage);
    }
  }

  private keepalive = () => {
    for (const channel of this.topicChannels.values()) {
      const message: BroadcastChannelPubSubMessage<Msg, PeerId> = {
        type: BroadcastChannelPubSubMessageType.Keepalive,
        from: this.peerId
      };
      channel.postMessage(message);
    }
  }

  private onPeerJoin = (event: TypedCustomEvent<PubSubPeerEvent.Join, PubSubPeerChangeData<PeerId>>) => {
    this.dispatchEvent(createEvent(PubSubPeerEvent.Join, event.detail));
  };

  private onPeerLeave = (event: TypedCustomEvent<PubSubPeerEvent.Leave, PubSubPeerChangeData<PeerId>>) => {
    this.dispatchEvent(createEvent(PubSubPeerEvent.Leave, event.detail));
  };
}

/** Options for initializing a {@link BroadcastChannelPubSub} */
export interface BroadcastChannelPubSubOptions<PeerId> {
  /** Peer ID of this instance. */
  peerId: PeerId;

  /** Keepalive message interval in milliseconds. Defaults to {@link DEFAULT_BROADCAST_CHANNEL_PUBSUB_KEEPALIVE_MS}. */
  keepaliveMs?: number;

  /**
   * Specifies the interval in milliseconds to monitor peers' subscriptions and emit join / leave events.
   * If set to false or <= 0, peers will not be monitored. Defaults to 1000 (1 second).
   */
  monitorPeers?: number | false;

  /** Function to get the current epoch timestamp. Defaults to `Date.now`. */
  now?: () => number;

  /** Factory type for a BroadcastChannel. */
  channelFactory?: new (name: string) => BroadcastChannel;
}

/** Internal message format for {@link BroadcastChannelPubSub}. */
export interface BroadcastChannelPubSubMessage<Msg, PeerId> {
  type: BroadcastChannelPubSubMessageType;
  from: PeerId;
  data?: Msg;
}

/** Internal message types for {@link BroadcastChannelPubSub}. */
export enum BroadcastChannelPubSubMessageType {
  Keepalive = 'Keepalive',
  Message = 'Message'
}
