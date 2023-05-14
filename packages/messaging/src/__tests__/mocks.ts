import { Equal, EventEmitter } from '@mithic/commons';
import { CID, MultihashDigest } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { MessageHandler, PeerAwarePubSub, PubSubMessage, PubSubPeerEvents, SubscribeOptions, MessageValidator } from '../pubsub.js';

export const LIBP2P_KEY_CODE = 0x72;

export class MockPubSub<PeerId = MockPeer> extends EventEmitter<PubSubPeerEvents<PeerId>> implements PeerAwarePubSub<Uint8Array, PeerId> {
  topicHandlers = new Map<string, MessageHandler<PubSubMessage<Uint8Array, PeerId>>>();
  topicValidators = new Map<string, MessageValidator<PubSubMessage<Uint8Array, PeerId>>>();
  subscriberMap = new Map<string, PeerId[]>();

  subscribe(topic: string, handler: MessageHandler<PubSubMessage<Uint8Array, PeerId>>, options?: SubscribeOptions<PubSubMessage<Uint8Array, PeerId>>): void {
    this.subscriberMap.set(topic, this.subscriberMap.get(topic) || []);
    this.topicHandlers.set(topic, handler);
    options?.validator && this.topicValidators.set(topic, options.validator);
  }

  unsubscribe(topic: string): void {
    this.subscriberMap.delete(topic);
    this.topicHandlers.delete(topic);
    this.topicValidators.delete(topic);
  }

  publish(): void {
    // NO-OP
  }

  topics(): Iterable<string> {
    return this.subscriberMap.keys();
  }

  subscribers(topic: string): Iterable<PeerId> {
    return this.subscriberMap.get(topic) || [];
  }

  close(): void {
    // NOOP
  }
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
