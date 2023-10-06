import { Equal, TypedEventTarget } from '@mithic/commons';
import { CID, MultihashDigest } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { PeerAwareMessageBus, PeerAwareMessageHandler, PeerAwareMessageValidator, PeerAwareSubscribeOptions, PeerEvents } from '../peer-aware.js';
import { MessageOptions, Unsubscribe } from '../messaging.js';

export const LIBP2P_KEY_CODE = 0x72;

export class MockMessageBus<Msg = Uint8Array, PeerId = MockPeer>
  extends TypedEventTarget<PeerEvents<PeerId>>
  implements PeerAwareMessageBus<Msg, PeerId>
{
  topicHandlers = new Map<string, PeerAwareMessageHandler<Msg, PeerId>>();
  topicValidators = new Map<string, PeerAwareMessageValidator<Msg, PeerId>>();
  subscriberMap = new Map<string, PeerId[]>();

  readonly defaultTopic = 'message';

  subscribe(
    handler: PeerAwareMessageHandler<Msg, PeerId>,
    options?: PeerAwareSubscribeOptions<Msg, PeerId>
  ): Unsubscribe {
    const topic = options?.topic ?? this.defaultTopic;
    this.subscriberMap.set(topic, this.subscriberMap.get(topic) || []);
    this.topicHandlers.set(topic, handler);
    options?.validator && this.topicValidators.set(topic, options.validator);
    return () => this.unsubscribe(topic);
  }

  unsubscribe(topic: string): void {
    this.subscriberMap.delete(topic);
    this.topicHandlers.delete(topic);
    this.topicValidators.delete(topic);
  }

  dispatch(): void {
    // NO-OP
  }

  topics(): Iterable<string> {
    return this.subscriberMap.keys();
  }

  subscribers(options?: MessageOptions): Iterable<PeerId> {
    return this.subscriberMap.get(options?.topic ?? this.defaultTopic) || [];
  }

  close(): void {
    // NOOP
  }
}

export interface MockMessage<T = Uint8Array, Peer = MockPeer> {
  /** The message's target topic. */
  topic: string;
  /** The message payload. */
  data: T;
  /** The peer that sends the message. */
  from?: Peer;
}


export class MockPeer implements Equal<MockPeer> {
  readonly type = 'Ed25519';

  constructor(public readonly publicKey: Uint8Array) { }

  get multihash(): MultihashDigest {
    return identity.digest(this.publicKey);
  }

  toString(): string {
    return this.toCID().toString();
  }

  toCID(): CID {
    return CID.createV1(LIBP2P_KEY_CODE, this.multihash);
  }

  toBytes(): Uint8Array {
    return this.multihash.bytes;
  }

  equals(other: MockPeer): boolean {
    return other === this;
  }
}
