import {
  BTreeMap, BTreeSet, MaybeAsyncAppendOnlySetBatch, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable, compareMultiKeys
} from '@mithic/collections';
import { AbortOptions, CodedError, MaybeAsyncIterableIterator, OperationError } from '@mithic/commons';
import { BaseEntityStore } from './base.js';
import { EntityAttrKey, EntityStore, AttrValueKey } from './store.js';

/** Map-based {@link EntityStore}. */
export class MapEntityStore<K, V> extends BaseEntityStore<K, V> implements EntityStore<K, V> {
  public constructor(
    /** Map of data entries. */
    protected readonly data: MaybeAsyncMapBatch<EntityAttrKey<K>, V> & RangeQueryable<EntityAttrKey<K>, V>
      = new BTreeMap(5, compareMultiKeys),
    /** Map of field value index. */
    protected readonly index: MaybeAsyncMapBatch<AttrValueKey<K, V>, K> & RangeQueryable<AttrValueKey<K, V>, K>
      = new BTreeMap(5, compareMultiKeys),
    /** Set of known entries. */
    protected readonly known: MaybeAsyncAppendOnlySetBatch<K> = new BTreeSet(5, compareMultiKeys),
  ) {
    super();
  }

  public getMany(keys: Iterable<EntityAttrKey<K>>, options?: AbortOptions): MaybeAsyncIterableIterator<V | undefined> {
    return this.data.getMany(keys, options);
  }

  public override hasMany(
    keys: Iterable<EntityAttrKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<boolean> {
    return this.data.hasMany(keys, options);
  }

  public isKnown(ids: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean> {
    return this.known.hasMany(ids, options);
  }

  public async * updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<K>, value?: V]>, options?: AbortOptions
  ): AsyncIterableIterator<CodedError<EntityAttrKey<K>> | undefined> {
    const entryArray = [...entries];
    const errors = new Array<Error | undefined>(entryArray.length);

    // TODO: optimize this

    // update indices
    {
      const indexArray = [] as [AttrValueKey<K, V>, K | undefined][];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[entityId, field, entryId], value] = entryArray[i];
        if (value !== void 0) {
          indexArray[i] = [[field, value, entryId], entityId];
        }
      }

      const deletedKeys = entryArray.filter(([, value]) => value === void 0).map(([key]) => key);
      if (deletedKeys.length) {
        let i = 0;
        for await (const value of this.data.getMany(deletedKeys, options)) {
          for (; i < entryArray.length && entryArray[i][1] !== void 0; ++i);
          if (value !== void 0) {
            const [[entityId, field, entryId]] = entryArray[i];
            indexArray[i] = [[field, value, entryId], entityId];
          }
          ++i;
        }
      }

      const indices = indexArray.filter((entry) => !!entry);
      if (indices.length) {
        let i = 0;
        for await (
          const error of this.index.updateMany(indices, options)
        ) {
          for (; i < indexArray.length && !indexArray[i]; ++i);
          if (error) { errors[i] = error; }
          ++i;
        }
      }
    }

    // update data entries
    {
      const entries = entryArray.filter((_, index) => errors[index] === void 0);
      if (entries.length) {
        let i = 0;
        for await (const error of this.data.updateMany(entries, options)) {
          for (; i < entryArray.length && errors[i]; ++i);
          if (error) { errors[i] = error; }
          ++i;
        }
      }
    }

    // update known set
    {
      const txIds = [] as (K | undefined)[];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[, , entryId], value] = entryArray[i];
        const isAdd = !errors[i] && entryId !== void 0 && value !== void 0;
        txIds.push(isAdd ? entryId : void 0);
      }
      const addedIds = txIds.filter((id) => id !== void 0) as K[];
      if (addedIds.length) {
        let i = 0;
        for await (const error of this.known.addMany(addedIds, options)) {
          for (; i < txIds.length && txIds[i] === void 0; ++i);
          if (error) { errors[i] = error; }
          ++i;
        }
      }
    }

    {
      let i = 0;
      for (const error of errors) {
        yield error ? new OperationError('failed to update', { detail: entryArray[i][0], cause: error }) : void 0;
        ++i;
      }
    }
  }

  public async * entriesByAttr(
    options?: RangeQueryOptions<AttrValueKey<K, V>>
  ): AsyncIterableIterator<[EntityAttrKey<K>, V]> {
    for await (const [[attr, value, txId], entityId] of this.index.entries(options)) {
      yield [[entityId, attr, txId], value as V];
    }
  }

  public entries(options?: RangeQueryOptions<EntityAttrKey<K>>): MaybeAsyncIterableIterator<[EntityAttrKey<K>, V]> {
    return this.data.entries(options);
  }

  public override keys(options?: RangeQueryOptions<EntityAttrKey<K>>): MaybeAsyncIterableIterator<EntityAttrKey<K>> {
    return this.data.keys(options);
  }

  public override values(options?: RangeQueryOptions<EntityAttrKey<K>>): MaybeAsyncIterableIterator<V> {
    return this.data.values(options);
  }

  public override get [Symbol.toStringTag](): string {
    return MapEntityStore.name;
  }
}
