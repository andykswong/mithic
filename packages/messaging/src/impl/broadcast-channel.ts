import { StringEquatable, TypedCustomEvent, TypedEventTarget, createEvent, maybeAsync } from '@mithic/commons';
import {
  PeerAwareMessageBus, PeerAwareMessageHandler, PeerAwareSubscribeOptions, PeerChangeData, PeerEvent, PeerEvents
} from '../peer-aware.ts';
import { DEFAULT_PEER_MONITOR_REFRESH_MS, PeerSubscriptionMonitor } from '../utils/index.ts';
import { MessageOptions, Unsubscribe } from '../messaging.ts';

/** Default keepalive ping interval for {@link BroadcastChannelMessageBus} in milliseconds. */
export const DEFAULT_BROADCAST_CHANNEL_MESSAGE_BUS_KEEPALIVE_MS = 1000;

/** Number of keepalive intervals to wait for before considering a peer as dropped. */
const NUM_KEEPALIVES_TO_WAIT = 3;
const DEFAULT_TOPIC = 'message';

/** {@link PeerAwareMessageBus} implementation using browser BroadcastChannel. */
export class BroadcastChannelMessageBus<Msg = Uint8Array, PeerId extends StringEquatable = string>
  extends TypedEventTarget<PeerEvents<PeerId>>
  implements PeerAwareMessageBus<Msg, PeerId>, Disposable {
  /** This peer's ID. */
  public readonly peerId: PeerId;
  /** The default topic to publish to. */
  public readonly defaultTopic: string;

  private readonly keepaliveMs: number;
  private readonly peerRefreshMs: number;
  private readonly now: () => number;
  private readonly channel: BroadcastChannel;

  private readonly topicSubscribers = new Map<string, Map<string, [peerId: PeerId, lastSeen: number]>>();
  private readonly topicHandlers = new Map<string, PeerAwareMessageHandler<Msg, PeerId>[]>();
  private peerMonitor?: PeerSubscriptionMonitor<PeerId>;
  private keepAliveTimer = 0;

  public constructor({
    peerId,
    keepaliveMs = DEFAULT_BROADCAST_CHANNEL_MESSAGE_BUS_KEEPALIVE_MS,
    monitorPeers = DEFAULT_PEER_MONITOR_REFRESH_MS,
    now = Date.now,
    channel = new BroadcastChannel(DEFAULT_TOPIC),
    defaultTopic = DEFAULT_TOPIC,
  }: BroadcastChannelPubSubOptions<PeerId>) {
    super();
    this.peerId = peerId;
    this.keepaliveMs = keepaliveMs;
    this.peerRefreshMs = monitorPeers && monitorPeers > 0 ? monitorPeers : 0;
    this.now = now;
    this.channel = channel;
    this.defaultTopic = defaultTopic;
  }

  public close(): void {
    this.channel.close();

    this.topicSubscribers.clear();
    this.topicHandlers.clear();

    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = 0;

    if (this.peerMonitor) {
      this.peerMonitor.removeEventListener(PeerEvent.Join, this.onPeerJoin);
      this.peerMonitor.removeEventListener(PeerEvent.Leave, this.onPeerLeave);
      this.peerMonitor.close();
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public subscribe(
    handler: PeerAwareMessageHandler<Msg, PeerId>,
    options?: PeerAwareSubscribeOptions<Msg, PeerId>
  ): Unsubscribe {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;
    const validatedHandler: PeerAwareMessageHandler<Msg, PeerId> = maybeAsync(function* (message, options) {
      if (!(yield validator?.(message, options))) {
        return handler(message, options);
      }
    });
    this.topicHandlers.set(topic, [...(this.topicHandlers.get(topic) || []), validatedHandler]);
    this.topicSubscribers.set(topic, this.topicSubscribers.get(topic) || new Map());

    this.channel.addEventListener('message', (event) => this.onMessage(topic, event));

    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(this.keepalive, this.keepaliveMs) as unknown as number;
    }

    if (this.peerRefreshMs && !this.peerMonitor?.started) {
      this.peerMonitor = this.peerMonitor || new PeerSubscriptionMonitor(this, this.peerRefreshMs, false);
      this.peerMonitor.addEventListener(PeerEvent.Join, this.onPeerJoin);
      this.peerMonitor.addEventListener(PeerEvent.Leave, this.onPeerLeave);
      this.peerMonitor.start();
    }

    return () => {
      const handlers = this.topicHandlers.get(topic);
      const index = handlers?.indexOf(validatedHandler) ?? -1;
      if (index >= 0) {
        handlers?.splice(index, 1);
      }
      if (handlers?.length === 0) {
        this.topicHandlers.delete(topic);
        this.topicSubscribers.delete(topic);
      }
    };
  }

  public dispatch(data: Msg, options?: MessageOptions): void {
    const message: BroadcastChannelMessage<Msg, PeerId> = {
      type: BroadcastChannelMessageType.Message,
      topic: options?.topic ?? this.defaultTopic,
      from: this.peerId,
      data
    };
    this.channel.postMessage(message);
  }

  public topics(): Iterable<string> {
    return this.topicHandlers.keys();
  }

  public * subscribers(options?: MessageOptions): Iterable<PeerId> {
    const subs = this.topicSubscribers.get(options?.topic ?? this.defaultTopic);
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

  private onMessage = maybeAsync(function* (
    this: BroadcastChannelMessageBus<Msg, PeerId>, topic: string, event: MessageEvent<unknown>
  ) {
    const message = event.data as BroadcastChannelMessage<Msg, PeerId>;

    if (
      !message.from ||
      (
        message.type !== BroadcastChannelMessageType.Message &&
        message.type !== BroadcastChannelMessageType.Keepalive
      )
    ) {
      return;
    }

    // Update last seen time of peer
    this.topicSubscribers.get(topic)?.set(`${message.from}`, [message.from, this.now()]);

    if (message.type === BroadcastChannelMessageType.Keepalive || message.data == void 0) {
      return;
    }

    // Dispatch message event if valid
    const handlers = this.topicHandlers.get(topic) || [];
    for (const handler of handlers) {
      yield handler(message.data, { topic, from: message.from });
    }
  }, this);

  private keepalive = () => {
    for (const topic of this.topicHandlers.keys()) {
      const message: BroadcastChannelMessage<Msg, PeerId> = {
        type: BroadcastChannelMessageType.Keepalive,
        topic,
        from: this.peerId
      };
      this.channel.postMessage(message);
    }
  }

  private onPeerJoin = (event: TypedCustomEvent<PeerEvent.Join, PeerChangeData<PeerId>>) => {
    this.dispatchEvent(createEvent(PeerEvent.Join, event.detail));
  };

  private onPeerLeave = (event: TypedCustomEvent<PeerEvent.Leave, PeerChangeData<PeerId>>) => {
    this.dispatchEvent(createEvent(PeerEvent.Leave, event.detail));
  };
}

/** Options for initializing a {@link BroadcastChannelMessageBus} */
export interface BroadcastChannelPubSubOptions<PeerId> {
  /** Peer ID of this instance. */
  readonly peerId: PeerId;

  /** Keepalive message interval in milliseconds. Defaults to {@link DEFAULT_BROADCAST_CHANNEL_MESSAGE_BUS_KEEPALIVE_MS}. */
  readonly keepaliveMs?: number;

  /**
   * Specifies the interval in milliseconds to monitor peers' subscriptions and emit join / leave events.
   * If set to false or <= 0, peers will not be monitored. Defaults to 1000 (1 second).
   */
  readonly monitorPeers?: number | false;

  /** Function to get the current epoch timestamp. Defaults to `Date.now`. */
  readonly now?: () => number;

  /** BroadcastChannel to use. */
  readonly channel?: BroadcastChannel;

  /** Default topic name. Defaults to `message`. */
  readonly defaultTopic?: string;
}

/** Internal message format for {@link BroadcastChannelMessageBus}. */
export interface BroadcastChannelMessage<Msg, PeerId> {
  type: BroadcastChannelMessageType;
  topic: string;
  from: PeerId;
  data?: Msg;
}

/** Internal message types for {@link BroadcastChannelMessageBus}. */
export enum BroadcastChannelMessageType {
  Keepalive = 'keepalive',
  Message = 'message'
}
