import { PeerId } from '@libp2p/interface-peer-id';
import { AbortOptions, EventHandler } from '@mithic/commons';
import {
  DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS, MessageHandler, MessageValidator, MessageValidatorResult, PeerAwarePubSub,
  PubSubMessage, PubSubPeerEvent, PubSubPeerEvents, PubSubPeerMonitor, SubscribeOptions
} from '@mithic/messaging';
import type { IPFS } from 'ipfs-core-types';
import type { create } from 'ipfs-core';
import { Message } from '@libp2p/interface-pubsub';

/** IPFS concrete type. */
type CIPFS = Awaited<ReturnType<typeof create>>;

/** IPFS implementation of a {@link PeerAwarePubSub}. */
export class IpfsPubSub implements PeerAwarePubSub<Uint8Array, PeerId> {
  protected readonly ipfs: CIPFS;
  protected readonly monitor?: PubSubPeerMonitor<PeerId>;
  protected readonly validators = new Map<string, MessageValidator<PubSubMessage<Uint8Array, PeerId>>>();
  protected readonly handlers = new Map<string, MessageHandler<PubSubMessage<Uint8Array, PeerId>>>();

  public constructor(ipfs: IPFS, options?: IpfsPubSubOptions) {
    this.ipfs = ipfs as CIPFS;
    const refreshMs = (options?.monitorPeers ?? DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS) || 0;
    if (refreshMs > 0) {
      this.monitor = new PubSubPeerMonitor(this, refreshMs, false);
    }
  }

  public async close(options?: AbortOptions): Promise<void> {
    this.monitor?.close();
    for (const topic of await this.ipfs.pubsub.ls(options)) {
      await this.ipfs.pubsub.unsubscribe(topic, this.onMessage, options);
    }
  }

  public async subscribe(
    topic: string,
    handler: MessageHandler<PubSubMessage<Uint8Array, PeerId>>,
    options?: SubscribeOptions<PubSubMessage<Uint8Array, PeerId>>
  ): Promise<void> {
    this.monitor?.start();
    this.handlers.set(topic, handler);
    if (options?.validator) {
      this.validators.set(topic, options.validator)
    }
    await this.ipfs.pubsub.subscribe(topic, this.onMessage, options);
  }

  public async unsubscribe(topic: string, options?: AbortOptions): Promise<void> {
    this.validators.delete(topic);
    this.handlers.delete(topic);
    await this.ipfs.pubsub.unsubscribe(topic, this.onMessage, options);
    if (this.monitor && !(await this.topics(options)).length) {
      this.monitor.close();
    }
  }

  public publish(topic: string, data: Uint8Array, options?: AbortOptions): Promise<void> {
    return this.ipfs.pubsub.publish(topic, data, options);
  }

  public topics(options?: AbortOptions): Promise<string[]> {
    return this.ipfs.pubsub.ls(options);
  }

  public subscribers(topic: string, options?: AbortOptions): Promise<PeerId[]> {
    return this.ipfs.pubsub.peers(topic, options);
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
    const validator = this.validators.get(message.detail.topic);
    if (!validator || validator(message.detail) === MessageValidatorResult.Accept) {
      return this.handlers.get(message.detail.topic)?.(message.detail);
    }
  };
}

/** Options for initializing a {@link IpfsPubSub}. */
export interface IpfsPubSubOptions {
  /**
   * Specifies the interval in milliseconds to monitor peers' subscriptions and emit join / leave events.
   * If set to false or <= 0, peers will not be monitored. Defaults to 1000 (1 second).
   */
  monitorPeers?: number | false;
}
