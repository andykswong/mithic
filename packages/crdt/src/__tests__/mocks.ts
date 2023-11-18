import { ContentId } from '@mithic/commons';
import { MultihashDigest, MultibaseEncoder } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import { StandardAction } from '../action.js';
import { BTreeMap, RangeKeyCodec, TransformedMap, TransformedSet } from '@mithic/collections';
import { FlatMultimapKeyCodec, MapStore, MultimapKey, createDefaultMapStore } from '../map/index.js';

export class MockId implements ContentId {
  code = 123;
  multihash!: MultihashDigest<number>;

  constructor(public bytes: Uint8Array = new Uint8Array()) {
  }

  get ['/']() {
    return this.bytes;
  }

  toJSON(): { '/': string; } {
    return { '/': this.toString() };
  }

  toString(base: MultibaseEncoder<string> = base64): string {
    return base.encode(this.bytes);
  }

  equals(rhs: MockId): boolean {
    return `${this}` === `${rhs}`;
  }

  static parse(id: string): MockId {
    return new MockId(base64.decode(id));
  }
}

export const getMockEventKey = (event: StandardAction) => new MockId(new Uint8Array(parseInt(event.nonce || '0')));

export const MockIdStringCodec: RangeKeyCodec<MockId, string> = {
  encode: (key: MockId): string => key.toString(),
  decode: MockId.parse,
};

export const MockMultimapKeyCodec: RangeKeyCodec<MultimapKey<MockId>, string> = {
  ...FlatMultimapKeyCodec,
  decode(compositeKey: string): MultimapKey<MockId> {
    const [root, field, key] = compositeKey.split(FlatMultimapKeyCodec.separator);
    return [MockId.parse(root), field, key ? MockId.parse(key) : void 0];
  },
};

export function createMockMapStore<V>(): { store: MapStore<MockId, V>, set: Set<string>, map: BTreeMap<string, V> } {
  const set = new Set<string>();
  const map = new BTreeMap<string, V>(5);
  const store = createDefaultMapStore<V, MockId>(
    new TransformedMap(map, MockMultimapKeyCodec),
    new TransformedSet(set, MockIdStringCodec),
  );
  return { store, set, map };
}
