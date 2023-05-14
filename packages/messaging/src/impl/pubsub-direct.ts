import { AbortOptions, MaybePromise, StringEquatable, equalsOrSameString } from '@mithic/commons';
import { PeerChannel, PeerMessage } from '../p2p.js';
import { PubSubMessage, MessageValidatorResult, PeerAwarePubSub, MessageValidator, MessageHandler } from '../pubsub.js';
import { waitForPeer } from './wait-peer.js';
import { PeerChannelOptions } from '../index.js';

/** Protocol name of pubsub-based direct channel. */
export const PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME = 'pubsub-direct';

/** Protocol semantic version of pubsub-based direct channel */
export const PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER = '0.1.0';

/** An implementation of {@link PeerChannel} that uses a unique {@link PubSub} topic for messaging. */
export class PubSubDirectChannel<Msg = Uint8Array, Peer extends StringEquatable<Peer> = string>
  implements PeerChannel<Msg, Peer>
{
  public readonly id: string;
  protected readonly protocol: string;
  protected readonly validator?: MessageValidator<PeerMessage<Msg, Peer>>;
  protected handler?: MessageHandler<PeerMessage<Msg, Peer>>;
  private _started = false;

  public constructor(
    protected readonly pubsub: PeerAwarePubSub<Msg, Peer>,
    public readonly self: Peer,
    public readonly peer: Peer,
    {
      protocol = `/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME}/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER}`,
      validator
    }: PubSubDirectChannelOptions<Msg, Peer> = {},
  ) {
    this.id = `${protocol}/${Array.from([self.toString(), peer.toString()]).sort().join('/')}`;
    this.protocol = protocol;
    this.validator = validator;
  }

  public get started(): boolean {
    return this._started;
  }

  public async start(options?: PeerChannelOptions<PeerMessage<Msg, Peer>>): Promise<void> {
    if (this._started) {
      return;
    }

    this.handler = options?.handler;
    await this.pubsub.subscribe(this.id, this.onMessage, { validator: this.validateMessage, ...options });
    await waitForPeer(this.pubsub, this.id, this.peer, options);
    this._started = true;
  }

  public publish(message: Msg, options?: AbortOptions): MaybePromise<void> {
    return this.pubsub.publish(this.id, message, options);
  }

  public close(): MaybePromise<void> {
    if (!this._started) {
      return;
    }

    this.handler = void 0;
    this._started = false;
    return this.pubsub.unsubscribe(this.id);
  }

  protected onMessage = (message: PubSubMessage<Msg, Peer>) => {
    if (message.from) {
      this.handler?.(message as PeerMessage<Msg, Peer>);
    }
  };

  protected validateMessage = (message: PubSubMessage<Msg, Peer>) => {
    // accept message only from target peer, rejecting others
    if (message.topic !== this.id || !message.from || !equalsOrSameString(message.from, this.peer)) {
      return MessageValidatorResult.Reject;
    }

    if (this.validator) {
      return this.validator(message as PeerMessage<Msg, Peer>);
    }

    return MessageValidatorResult.Accept;
  };

  protected isPeer = (value: Peer) => equalsOrSameString(this.peer, value);
}

/** Options for initializing a {@link PubSubDirectChannel} */
export interface PubSubDirectChannelOptions<Msg, Peer extends StringEquatable> {
  /** Protocol name and semver. */
  protocol?: string;

  /** Message validator function. */
  validator?: MessageValidator<PeerMessage<Msg, Peer>>,
}
