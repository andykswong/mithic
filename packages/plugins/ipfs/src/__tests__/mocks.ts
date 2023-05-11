import { Ed25519PeerId, PeerId } from '@libp2p/interface-peer-id';
import { PublishResult as Libp2pPubSubResult, PubSub as ILibp2pPubSub, PubSubEvents as Libp2pPubSubEvents, StrictSign, TopicValidatorFn as Libp2pTopicValidatorFn } from '@libp2p/interface-pubsub';
import { EventEmitter } from '@libp2p/interfaces/events';
import { notFoundError } from '@mithic/commons';
import { IPFS } from 'ipfs-core-types';
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

export class MockIpfs implements IPFS {
  bitswap!: IPFS['bitswap'];
  bootstrap!: IPFS['bootstrap'];
  config!: IPFS['config'];
  dag!: IPFS['dag'];
  dht!: IPFS['dht'];
  diag!: IPFS['diag'];
  files!: IPFS['files'];
  key!: IPFS['key'];
  log!: IPFS['log'];
  name!: IPFS['name'];
  object!: IPFS['object'];
  pin!: IPFS['pin'];
  refs!: IPFS['refs'];
  repo!: IPFS['repo'];
  stats!: IPFS['stats'];
  swarm!: IPFS['swarm'];
  bases!: IPFS['bases'];
  codecs!: IPFS['codecs'];
  hashers!: IPFS['hashers'];

  block = {
    data: new Map<string, [CID, Uint8Array]>(),

    async get(cid: CID): Promise<Uint8Array> {
      const data = this.data.get(cid.toString());
      if (data) {
        return data[1];
      }
      throw notFoundError('not found');
    },
    async put(input: Uint8Array): Promise<CID> {
      const cid = ([...this.data].find(([, val]) => val[1] === input))?.[1][0];
      if (cid) {
        return cid;
      }
      throw new Error('mismatched data');
    },
    async * rm(cid: CID | CID[]): AsyncIterable<{ cid: CID, error?: Error }> {
      const cids = !Array.isArray(cid) ? [cid] : cid;
      for (const cid of cids) {
        if (!this.data.delete(cid.toString())) {
          yield { cid, error: new Error('mismatched data') };
          return;
        }
        yield { cid };
      }
    }
  };

  pubsub = {
    subscribers: new Map<string, PeerId[]>(),

    async subscribe(topic: string) {
      this.subscribers.set(topic, this.subscribers.get(topic) || []);
    },
    async unsubscribe(topic: string) {
      this.subscribers.delete(topic);
    },
    async publish() { return; },
    async ls(): Promise<string[]> {
      return Array.from(this.subscribers.keys());
    },
    async peers(topic: string): Promise<PeerId[]> {
      return this.subscribers.get(topic) || [];
    }
  };
}
