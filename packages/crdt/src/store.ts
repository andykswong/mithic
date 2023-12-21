import {
  BTreeMap, BTreeSet, MaybeAsyncAppendOnlySetBatch, MaybeAsyncMapBatch, MaybeAsyncReadonlyMapBatch,
  MaybeAsyncReadonlySetBatch, RangeQueryable
} from '@mithic/collections';
import { ContentId } from '@mithic/commons';
import { compareCIDMultiKeys } from './defaults.js';

/** Map-based store for CRDTs. */
export interface MapStore<K, V> extends ReadonlyMapStore<K, V> {
  /** Data multimap. */
  readonly data: Multimap<K, V>;

  /** Optional tombstoned event key set for causal dependency tracking. */
  readonly tombstone?: MaybeAsyncAppendOnlySetBatch<K>;
}

/** Readonly {@link MapStore}. */
export interface ReadonlyMapStore<K, V> {
  /** Data multimap. */
  readonly data: ReadonlyMultimap<K, V>;

  /** Optional tombstoned event key set for causal dependency tracking. */
  readonly tombstone?: MaybeAsyncReadonlySetBatch<K>;
}

/** Multi-valued map. */
export interface Multimap<K, V> extends ReadonlyMultimap<K, V>,
  MaybeAsyncMapBatch<MultimapKey<K>, V> { }

/** Readonly {@link Multimap}. */
export interface ReadonlyMultimap<K, V> extends
  MaybeAsyncReadonlyMapBatch<MultimapKey<K>, V>, RangeQueryable<MultimapKey<K>, V> { }

/** Key of a multimap item. */
export type MultimapKey<K> = readonly [root: K, field: string, itemKey?: K];

/** Creates a default {@link MapStore} from a backing map. */
export function createDefaultMapStore<V, K = ContentId>(
  data: Multimap<K, V> = new BTreeMap<MultimapKey<K>, V>(5, compareCIDMultiKeys),
  tombstone: MaybeAsyncAppendOnlySetBatch<K> = new BTreeSet<K>(5, compareCIDMultiKeys),
): MapStore<K, V> {
  return { data, tombstone };
}
