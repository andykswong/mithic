import { MaybePromise, StringEquatable, equalsOrSameString } from '@mithic/commons';
import { MessageBus, MessageOptions, Unsubscribe } from '../messaging.js';
import {
  PeerAwareMessageHandler, PeerAwareMessageOptions, PeerAwareMessageValidator, PeerAwareSubscribeOptions
} from '../peer-aware.js';
import { MessageValidationError, MessageValidationErrorCode } from '../error.js';

/** Protocol name of pubsub-based direct channel. */
export const PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME = 'pubsub-direct';

/** Protocol semantic version of pubsub-based direct channel */
export const PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER = '0.1.0';

/**
 * A message bus adapter that uses a unique topic for messaging with specific peer on a peer-aware message bus.
 */
export class DirectMessageBus<Msg = Uint8Array, Peer extends StringEquatable<Peer> = string, InMsg = Msg>
  implements MessageBus<Msg, InMsg, PeerAwareMessageOptions<Peer>>
{
  public readonly id: string;

  public constructor(
    protected readonly bus: MessageBus<Msg, InMsg, PeerAwareMessageOptions<Peer>>,
    public readonly self: Peer,
    public readonly peer: Peer,
    protected readonly protocol = `/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME}/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER}`,
  ) {
    this.id = `${protocol}/${Array.from([self.toString(), peer.toString()]).sort().join('/')}`;
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(message: Msg, options?: MessageOptions): MaybePromise<void> {
    return this.bus.dispatch(message, { ...options, topic: this.id });
  }

  public subscribe(
    handler: PeerAwareMessageHandler<InMsg, Peer>, options?: PeerAwareSubscribeOptions<InMsg, Peer>
  ): MaybePromise<Unsubscribe> {
    const topic = this.getFullTopic(options?.topic);
    const validator = this.validateMessage.bind(this, options?.topic || '', options?.validator);
    return this.bus.subscribe(this.onMessage.bind(this, handler), { ...options, topic, validator });
  }

  /** Given a topic, returns the full topic ID for underlying message bus. */
  public getFullTopic = (topic?: string): string => topic ? `${this.id}/${topic}` : this.id;

  /** Resolves a full topic ID to local topic ID. */
  public resolveTopic = (fullTopic?: string): string | undefined =>
    fullTopic?.startsWith(this.id) ? fullTopic.slice(this.id.length + 1) : undefined;

  protected onMessage(
    handler: PeerAwareMessageHandler<InMsg, Peer>,
    message: InMsg,
    options?: PeerAwareMessageOptions<Peer>
  ) {
    return handler(message, { ...options, topic: this.resolveTopic(options?.topic) });
  }

  protected validateMessage(
    topic: string,
    validator: PeerAwareMessageValidator<InMsg, Peer> | undefined,
    message: InMsg,
    options?: PeerAwareMessageOptions<Peer>
  ) {
    // accept message only from target peer, rejecting others
    if (
      options?.topic !== this.getFullTopic(topic) ||
      !options?.from ||
      !equalsOrSameString(options.from, this.peer)
    ) {
      return new MessageValidationError('invalid message', { code: MessageValidationErrorCode.Ignore });
    }

    return validator?.(message, { ...options, topic });
  }

  protected isPeer = (value: Peer) => equalsOrSameString(this.peer, value);
}
