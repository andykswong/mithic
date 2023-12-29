import {
  BTreeMap, BTreeSet, MaybeAsyncAppendOnlySetBatch, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable, compareMultiKeys
} from '@mithic/collections';
import { AbortOptions, CodedError, MaybeAsyncIterableIterator, OperationError } from '@mithic/commons';
import { BaseEntityStore } from './base.js';
import { EntityFieldKey, EntityStore, FieldValueKey } from './store.js';

/** Map-based {@link EntityStore}. */
export class MapEntityStore<K, V> extends BaseEntityStore<K, V> implements EntityStore<K, V> {
  public constructor(
    /** Map of data entries. */
    protected readonly data: MaybeAsyncMapBatch<EntityFieldKey<K>, V> & RangeQueryable<EntityFieldKey<K>, V>
      = new BTreeMap(5, compareMultiKeys),
    /** Map of field value index. */
    protected readonly index: MaybeAsyncMapBatch<FieldValueKey<K, V>, K> & RangeQueryable<FieldValueKey<K, V>, K>
      = new BTreeMap(5, compareMultiKeys),
    /** Set of known entries. */
    protected readonly known: MaybeAsyncAppendOnlySetBatch<K> = new BTreeSet(5, compareMultiKeys),
  ) {
    super();
  }

  public getMany(keys: Iterable<EntityFieldKey<K>>, options?: AbortOptions): MaybeAsyncIterableIterator<V | undefined> {
    return this.data.getMany(keys, options);
  }

  public override hasMany(
    keys: Iterable<EntityFieldKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<boolean> {
    return this.data.hasMany(keys, options);
  }

  public hasEntries(ids: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean> {
    return this.known.hasMany(ids, options);
  }

  public async * updateMany(
    entries: Iterable<readonly [key: EntityFieldKey<K>, value?: V]>, options?: AbortOptions
  ): AsyncIterableIterator<CodedError<EntityFieldKey<K>> | undefined> {
    const entryArray = [...entries];
    const errors = new Array<Error | undefined>(entryArray.length);

    // TODO: optimize this

    // update indices
    {
      const indexArray = [] as [FieldValueKey<K, V>, K | undefined][];
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
      const entryIds = [] as (K | undefined)[];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[, , entryId], value] = entryArray[i];
        const isAdd = !errors[i] && entryId !== void 0 && value !== void 0;
        entryIds.push(isAdd ? entryId : void 0);
      }
      const addedEntries = entryIds.filter((id) => id !== void 0) as K[];
      if (addedEntries.length) {
        let i = 0;
        for await (const error of this.known.addMany(addedEntries, options)) {
          for (; i < entryIds.length && entryIds[i] === void 0; ++i);
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

  public entities(options?: RangeQueryOptions<FieldValueKey<K, V>>): MaybeAsyncIterableIterator<K> {
    return this.index.values(options);
  }

  public entries(options?: RangeQueryOptions<EntityFieldKey<K>>): MaybeAsyncIterableIterator<[EntityFieldKey<K>, V]> {
    return this.data.entries(options);
  }

  public override keys(options?: RangeQueryOptions<EntityFieldKey<K>>): MaybeAsyncIterableIterator<EntityFieldKey<K>> {
    return this.data.keys(options);
  }

  public override values(options?: RangeQueryOptions<EntityFieldKey<K>>): MaybeAsyncIterableIterator<V> {
    return this.data.values(options);
  }

  public override get [Symbol.toStringTag](): string {
    return MapEntityStore.name;
  }
}
