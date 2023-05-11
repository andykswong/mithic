import { PeerId } from '@libp2p/interface-peer-id';
import { Message, PubSub as ILibp2pPubSub, StrictSign, TopicValidatorResult } from '@libp2p/interface-pubsub';
import { EventHandler } from '@mithic/commons';
import {
  DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS, MessageHandler, PeerAwarePubSub, PubSubMessage, PubSubPeerEvent,
  PubSubPeerEvents, PubSubPeerMonitor, SubscribeOptions
} from '@mithic/messaging';

const EVENT_MSG = 'message';

/** Libp2p implementation of {@link PubSub}. */
export class Libp2pPubSub implements PeerAwarePubSub<Uint8Array, PeerId> {
  protected readonly handlers = new Map<string, MessageHandler<PubSubMessage<Uint8Array, PeerId>>>();
  protected readonly monitor?: PubSubPeerMonitor<PeerId>;

  public constructor(protected readonly pubsub: ILibp2pPubSub, options?: Libp2pPubSubOptions) {
    const refreshMs = (options?.monitorPeers ?? DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS) || 0;
    if (refreshMs > 0) {
      this.monitor = new PubSubPeerMonitor(this, refreshMs, false);
    }
    this.pubsub.addEventListener(EVENT_MSG, this.onMessage);
  }

  /** Returns if signature is strictly required. */
  public get strictSign(): boolean {
    return this.pubsub.globalSignaturePolicy === StrictSign;
  }

  public close(): void {
    this.monitor?.close();
    for (const topic of this.pubsub.getTopics()) {
      this.pubsub.unsubscribe(topic);
    }
    this.pubsub.removeEventListener(EVENT_MSG, this.onMessage);
  }

  public subscribe(
    topic: string,
    handler: MessageHandler<PubSubMessage<Uint8Array, PeerId>>,
    options?: SubscribeOptions<PubSubMessage<Uint8Array, PeerId>>
  ): void {
    this.monitor?.start();
    if (options?.validator) {
      const validator = options.validator;
      this.pubsub.topicValidators.set(topic, (_, message) => validator(message) as unknown as TopicValidatorResult);
    }
    this.handlers.set(topic, handler);
    this.pubsub.subscribe(topic);
  }

  public unsubscribe(topic: string): void {
    this.pubsub.unsubscribe(topic);
    this.pubsub.topicValidators.delete(topic);
    this.handlers.delete(topic);
    if (!this.pubsub.getTopics().length) {
      this.monitor?.close();
    }
  }

  public async publish(topic: string, message: Uint8Array): Promise<void> {
    await this.pubsub.publish(topic, message);
  }

  public topics(): string[] {
    return this.pubsub.getTopics();
  }

  public subscribers(topic: string): PeerId[] {
    return this.pubsub.getSubscribers(topic);
  }

  public addListener<K extends keyof PubSubPeerEvents<PeerId>>(
    type: K, listener: EventHandler<PubSubPeerEvents<PeerId>[K], void>
  ): this {
    this.monitor?.addListener(
      type,
      listener as EventHandler<PubSubPeerEvents<PeerId>[PubSubPeerEvent.Join | PubSubPeerEvent.Leave]>,
    );
    return this;
  }

  public removeListener<K extends keyof PubSubPeerEvents<PeerId>>(
    type: K, listener: EventHandler<PubSubPeerEvents<PeerId>[K], void>
  ): this {
    this.monitor?.removeListener(
      type,
      listener as EventHandler<PubSubPeerEvents<PeerId>[PubSubPeerEvent.Join | PubSubPeerEvent.Leave]>,
    );
    return this;
  }

  public removeAllListeners<K extends keyof PubSubPeerEvents<PeerId>>(type?: K | undefined): this {
    this.monitor?.removeAllListeners(type);
    return this;
  }

  protected onMessage = (message: CustomEvent<Message>) => {
    return this.handlers.get(message.detail.topic)?.(message.detail);
  };
}

/** Options for initializing a {@link Libp2pPubSub}. */
export interface Libp2pPubSubOptions {
  /**
   * Specifies the interval in milliseconds to monitor peers' subscriptions and emit join / leave events.
   * If set to false or <= 0, peers will not be monitored. Defaults to 1000 (1 second).
   */
  monitorPeers?: number | false;
}
