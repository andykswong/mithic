import { Ed25519PeerId, PeerId } from '@libp2p/interface-peer-id';
import { PublishResult as Libp2pPubSubResult, PubSub as ILibp2pPubSub, PubSubEvents as Libp2pPubSubEvents, StrictSign, TopicValidatorFn as Libp2pTopicValidatorFn } from '@libp2p/interface-pubsub';
import { EventEmitter } from '@libp2p/interfaces/events';
import { CID, MultihashDigest } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';

export const LIBP2P_KEY_CODE = 0x72;

export class MockLibp2pPubSub extends EventEmitter<Libp2pPubSubEvents> implements ILibp2pPubSub {
  globalSignaturePolicy: 'StrictSign' | 'StrictNoSign' = StrictSign;
  multicodecs: string[] = [];
  topicValidators = new Map<string, Libp2pTopicValidatorFn>();
  subscribers = new Map<string, PeerId[]>();
  topics = new Set<string>();

  getPeers(): PeerId[] {
    const peers = new Set(Array.from(this.subscribers.values()).flat(1));
    return Array.from(peers);
  }

  getTopics(): string[] {
    return Array.from(this.topics);
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic);
  }

  getSubscribers(topic: string): PeerId[] {
    return this.subscribers.get(topic) || [];
  }

  async publish(topic: string): Promise<Libp2pPubSubResult> {
    return { recipients: this.subscribers.get(topic) || [] };
  }
}

export class MockPeer implements Ed25519PeerId {
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

  equals(other: string | PeerId | Uint8Array): boolean {
    return other === this;
  }
}

export class MockEvent<T = unknown> extends Event {
  /** Returns any data passed when initializing the event. */
  public readonly detail: T;

  public constructor(type: string, eventInitDict?: CustomEventInit<T>) {
    super(type, eventInitDict);
    this.detail = eventInitDict?.detail as T;
  }
}
