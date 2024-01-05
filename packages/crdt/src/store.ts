import {
  BTreeSet, MaybeAsyncAppendOnlySetBatch, MaybeAsyncReadonlySetBatch, compareMultiKeys
} from '@mithic/collections';
import { MapTripleStore, ReadonlyTripleStore, TripleStore } from '@mithic/triplestore';

/** Store of tagged entity triples and processed transaction Ids. */
export interface EntityStore<Id, V> extends ReadonlyEntityStore<Id, V> {
  store(type?: string): TripleStore<Id, V>;

  readonly tx: MaybeAsyncAppendOnlySetBatch<Id>;
}

/** Readonly {@link EntityStore}. */
export interface ReadonlyEntityStore<Id, V> {
  /** Provides {@link TripleStore} of given entity type. */
  store(type?: string): ReadonlyTripleStore<Id, V>;

  /** Set of transaction (event) Ids processed by this store. */
  readonly tx: MaybeAsyncReadonlySetBatch<Id>;
}

/** Default implementation of {@link EntityStore}. */
export class DefaultEntityStore<Id, V> implements EntityStore<Id, V> {
  protected readonly stores: Map<string, TripleStore<Id, V>> = new Map();

  public constructor(
    /** Provider of {@link TripleStore}. */
    protected readonly provider: (type: string) => TripleStore<Id, V> = () => new MapTripleStore(),
    public readonly tx: MaybeAsyncAppendOnlySetBatch<Id> = new BTreeSet(5, compareMultiKeys),
  ) {
  }

  public store(type = ''): TripleStore<Id, V> {
    let store = this.stores.get(type);
    if (!store) {
      store = this.provider(type);
      this.stores.set(type, store);
    }
    return store;
  }
}
