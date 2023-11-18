import {
  BTreeMap, KeyRange, MaybeAsyncAppendOnlySetBatch, MaybeAsyncMap, MaybeAsyncMapBatch, MaybeAsyncReadonlyMapBatch,
  MaybeAsyncReadonlySetBatch, RangeKeyCodec, RangeQueryable, TransformedMap, TransformedSet
} from '@mithic/collections';
import { Codec, ContentId, IdentityCodec, ToString } from '@mithic/commons';
import { decodeCID } from '../defaults.js';

/** Map-based store for CRDTs. */
export interface MapStore<K, V> extends ReadonlyMapStore<K, V> {
  /** Data multimap. */
  readonly data: Multimap<K, V>;

  /** Optional tombstoned event key set for causal dependency tracking. */
  readonly tombstone?: MaybeAsyncAppendOnlySetBatch<K>;
}

/** Readonly map-based store for CRDTs. */
export interface ReadonlyMapStore<K, V> {
  /** Data multimap. */
  readonly data: ReadonlyMultimap<K, V>;

  /** Optional tombstoned event key set for causal dependency tracking. */
  readonly tombstone?: MaybeAsyncReadonlySetBatch<K>;
}

/** Multimap Store. */
export interface Multimap<K, V> extends ReadonlyMultimap<K, V>,
  MaybeAsyncMapBatch<MultimapKey<K>, V> { }

/** Readonly multimap. */
export interface ReadonlyMultimap<K, V> extends
  MaybeAsyncReadonlyMapBatch<MultimapKey<K>, V>, RangeQueryable<MultimapKey<K>, V> { }

/** Key of a multimap item. */
export type MultimapKey<K> = readonly [root: K, field: string, itemKey?: K];

/** CID-based key codec. */
export const CIDKeyCodec = {
  encode: (key: ToString): string => `${key}`,
  decode: decodeCID
};

/** Flat multimap CID-based key codec. */
export const FlatMultimapKeyCodec = {
  /** Key component separator pattern. */
  separator: '\udbff\udfff' as const,
  /** Max character. */
  terminal: '\udbff\udfff' as const,
  encode(key: MultimapKey<ToString>): string {
    const parts = [...key];
    while (parts[parts.length - 1] === void 0) {
      parts.pop();
    }
    return key.join(this.separator);
  },
  decode(key: string): MultimapKey<ContentId> {
    const parts = key.split(this.separator);
    const result: [root: ContentId, field: string, itemKey?: ContentId] = [CIDKeyCodec.decode(parts[0]), parts[1]];
    if (parts.length > 2) {
      result.push(CIDKeyCodec.decode(parts[2]));
    }
    return result;
  },
  encodeRange(options: KeyRange<MultimapKey<ToString>>): KeyRange<string> {
    let lt = options?.lt ? this.encode(options.lt) : void 0;
    let lte: string | undefined = void 0;
    if (options?.lte) {
      const parts = [...options.lte];
      while (parts[parts.length - 1] === void 0) {
        parts.pop();
      }

      if (parts.length < 3) {
        parts.push(this.terminal);
        lt = this.encode(parts as unknown as MultimapKey<ToString>);
      } else {
        lt = void 0;
        lte = this.encode(parts as unknown as MultimapKey<ToString>);
      }
    }

    return {
      ...options,
      gt: options?.gt ? this.encode(options.gt) : void 0,
      gte: options?.gte ? this.encode(options.gte) : void 0,
      lt,
      lte,
    };
  },
};

/** Creates a default {@link MapStore} from a backing map. */
export function createDefaultMapStore<V, K = ContentId>(
  data: Multimap<K, V> = createFlatMultimap(),
  tombstone: MaybeAsyncAppendOnlySetBatch<K> =
    new TransformedSet<K, string>(new Set(), CIDKeyCodec as Codec<K, string>),
): MapStore<K, V> {
  return { data, tombstone };
}

/** Creates a flat {@link Multimap} from a backing map. */
export function createFlatMultimap<
  V, K = ContentId,
  TK = string, TV = V,
  M extends MaybeAsyncMap<TK, TV> & MaybeAsyncMapBatch<TK, TV> & RangeQueryable<TK, TV>
  = MaybeAsyncMap<TK, TV> & MaybeAsyncMapBatch<TK, TV> & RangeQueryable<TK, TV>
>(
  backingMap: M = new BTreeMap<TK, TV>(5) as unknown as M,
  keyCodec: RangeKeyCodec<MultimapKey<K>, TK> = FlatMultimapKeyCodec as unknown as RangeKeyCodec<MultimapKey<K>, TK>,
  valueCodec: Codec<V, TV> = IdentityCodec as Codec<V, TV>
): Multimap<K, V> {
  return new TransformedMap(backingMap, keyCodec, valueCodec);
}
