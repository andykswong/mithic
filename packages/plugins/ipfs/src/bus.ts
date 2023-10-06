import { PeerId } from '@libp2p/interface-peer-id';
import { Message, PubSub as ILibp2pPubSub, StrictSign, TopicValidatorResult } from '@libp2p/interface-pubsub';
import { DisposableCloseable, EventsOfType, TypedEventHandler, maybeAsync } from '@mithic/commons';
import {
  DEFAULT_PEER_MONITOR_REFRESH_MS, MessageOptions, MessageValidationErrorCode, PeerAwareMessageBus,
  PeerAwareMessageHandler, PeerAwareMessageValidator, PeerAwareSubscribeOptions, PeerEvent, PeerEvents,
  PeerSubscriptionMonitor, Unsubscribe
} from '@mithic/messaging';

const DEFAULT_TOPIC = 'message';
const EVENT_MSG = 'message';

/** Libp2p implementation of {@link PeerAwareMessageBus}. */
export class Libp2pMessageBus extends DisposableCloseable
  implements PeerAwareMessageBus<Uint8Array, PeerId>, Disposable {

  protected readonly validators = new Map<string, PeerAwareMessageValidator<Uint8Array, PeerId>[]>();
  protected readonly handlers = new Map<string, PeerAwareMessageHandler<Uint8Array, PeerId>[]>();
  protected readonly monitor?: PeerSubscriptionMonitor<PeerId>;

  public constructor(
    /** Libp2p PubSub instance. */
    protected readonly pubsub: ILibp2pPubSub,
    /** Default topic to use when dispatching messages. */
    public readonly defaultTopic: string = DEFAULT_TOPIC,
    /**
     * Specifies the interval in milliseconds to monitor peers' subscriptions and emit join / leave events.
     * If set to false or <= 0, peers will not be monitored. Defaults to 1000 (1 second).
     */
    monitorPeers: number | false = DEFAULT_PEER_MONITOR_REFRESH_MS
  ) {
    super();
    const refreshMs = monitorPeers || 0;
    if (refreshMs > 0) {
      this.monitor = new PeerSubscriptionMonitor(this, refreshMs, false);
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

  public async dispatch(message: Uint8Array, options?: MessageOptions): Promise<void> {
    await this.pubsub.publish(options?.topic ?? this.defaultTopic, message);
  }

  public subscribe(
    handler: PeerAwareMessageHandler<Uint8Array, PeerId>,
    options?: PeerAwareSubscribeOptions<Uint8Array, PeerId>
  ): Unsubscribe {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;

    if (validator) {
      this.validators.set(topic, [...(this.validators.get(topic) || []), validator]);
      this.pubsub.topicValidators.set(topic, this.onValidate)
    }
    this.handlers.set(topic, [...(this.handlers.get(topic) || []), handler]);

    this.monitor?.start();
    this.pubsub.subscribe(topic);

    return () => {
      const handlers = this.handlers.get(topic);
      const validators = this.validators.get(topic);
      let index = handlers?.indexOf(handler) ?? -1;
      index >= 0 && handlers?.splice(index, 1);
      index = (validator && validators?.indexOf(validator)) ?? -1;
      index >= 0 && validators?.splice(index, 1);

      if (!handlers?.length) {
        this.pubsub.unsubscribe(topic);
        this.pubsub.topicValidators.delete(topic);
      }
      if (!this.pubsub.getTopics().length) {
        this.monitor?.close();
      }
    };
  }

  public topics(): string[] {
    return this.pubsub.getTopics();
  }

  public subscribers(options?: MessageOptions): PeerId[] {
    return this.pubsub.getSubscribers(options?.topic ?? this.defaultTopic);
  }

  public addEventListener<K extends PeerEvent>(
    type: K, listener: TypedEventHandler<EventsOfType<PeerEvents<PeerId>, K>>
  ): void {
    this.monitor?.addEventListener(type, listener);
  }

  public removeEventListener<K extends PeerEvent>(
    type: K, listener: TypedEventHandler<EventsOfType<PeerEvents<PeerId>, K>>
  ): void {
    this.monitor?.removeEventListener(type, listener);
  }

  protected onMessage = maybeAsync(function* (this: Libp2pMessageBus, message: CustomEvent<Message>) {
    const topic = message.detail.topic;
    const from = message.detail.type === 'signed' ? message.detail.from : void 0;
    const handlers = this.handlers.get(topic) || [];
    for (const handler of handlers) {
      yield handler(message.detail.data, { topic, from });
    }
  }, this);

  protected onValidate = async (_: PeerId, message: Message): Promise<TopicValidatorResult> => {
    const from = message.type === 'signed' ? message.from : void 0;
    const validators = this.validators.get(message.topic) || [];
    for (const validator of validators) {
      const result = await validator(message.data, { topic: message.topic, from });
      if (result?.code === MessageValidationErrorCode.Ignore) {
        return TopicValidatorResult.Ignore;
      } else if (result?.code === MessageValidationErrorCode.Reject) {
        return TopicValidatorResult.Reject;
      }
    }
    return TopicValidatorResult.Accept;
  };
}
