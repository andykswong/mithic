import {
  BTreeMap, BTreeSet, MaybeAsyncAppendOnlySetBatch, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable,
  compareMultiKeys
} from '@mithic/collections';
import { AbortOptions, CodedError, MaybeAsyncIterableIterator, OperationError } from '@mithic/commons';
import { EntityAttrKey, EntityStore, AttrValueSearchKey, EntityAttrSearchKey } from './store.js';

const TERMINAL = '\udbff\udfff';

/** Map-based {@link EntityStore}. */
export class MapEntityStore<Id, V> implements EntityStore<Id, V>, AsyncIterable<[EntityAttrKey<Id>, V]> {
  public constructor(
    /** Map of data entries. */
    protected readonly data:
      MaybeAsyncMapBatch<EntityAttrKey<Id>, V> & RangeQueryable<EntityAttrKey<Id>, V>
      = new BTreeMap(5, compareMultiKeys),
    /** Map of field value index. */
    protected readonly index:
      MaybeAsyncMapBatch<AttrValueStoreKey<Id, V>, Id> & RangeQueryable<AttrValueStoreKey<Id, V>, Id>
      = new BTreeMap(5, compareMultiKeys),
    /** Set of known entries. */
    protected readonly known: MaybeAsyncAppendOnlySetBatch<Id> = new BTreeSet(5, compareMultiKeys),
  ) {
  }

  public async * entries(
    options?: RangeQueryOptions<EntityAttrSearchKey<Id>>
  ): AsyncIterableIterator<[EntityAttrKey<Id>, V]> {
    let lower: EntityAttrKey<Id> | undefined, upper: EntityAttrKey<Id> | undefined;
    if (options?.lower) {
      lower = [options.lower[0], options.lower[1] ?? ''];
    }
    if (options?.upper) {
      upper = [options.upper[0], getAttrUpperBound(options.upper[1], options.upperOpen ?? true)];
    }

    for await (const [[entityId, attr, txId], value] of this.data.entries({
      ...options, lower, upper, upperOpen: true,
    })) {
      yield [[entityId, attr, txId], value];
    }
  }

  public async * entriesByAttr(
    options?: RangeQueryOptions<AttrValueSearchKey<V>>
  ): AsyncIterableIterator<[EntityAttrKey<Id>, V]> {
    let lower: AttrValueStoreKey<Id, V> | undefined, upper: AttrValueStoreKey<Id, V> | undefined;
    if (options?.lower) {
      lower = options.lower[1] === void 0 ? [options.lower[0]] : [options.lower[0], options.lower[1]];
    }
    if (options?.upper) {
      if (options.upper[1] === void 0) {
        upper = [getAttrUpperBound(options.upper[0], options.upperOpen ?? true)];
      } else {
        upper = [options.upper[0], options.upper[1], TERMINAL];
      }
    }

    for await (const [[attr, value, , txId], entityId] of this.index.entries({
      ...options, lower, upper, upperOpen: true,
    })) {
      yield [[entityId, attr, txId], value as V];
    }
  }

  public * findMany(
    keys: Iterable<EntityAttrSearchKey<Id>>, options?: AbortOptions
  ): IterableIterator<AsyncIterableIterator<[EntityAttrKey<Id>, V]>> {
    for (const key of keys) {
      yield this.entries({ ...options, lower: key, upper: key, upperOpen: false });
    }
  }

  public * findManyByAttr(
    keys: Iterable<AttrValueSearchKey<V>>, options?: AbortOptions
  ): IterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>> {
    for (const key of keys) {
      yield this.entriesByAttr({ ...options, lower: key, upper: key, upperOpen: false });
    }
  }

  public getMany(
    keys: Iterable<EntityAttrKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<V | undefined> {
    return this.data.getMany(keys, options);
  }

  public hasTx(ids: Iterable<Id>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean> {
    return this.known.hasMany(ids, options);
  }

  public async * updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<Id>, value?: V]>, options?: AbortOptions
  ): AsyncIterableIterator<CodedError<EntityAttrKey<Id>> | undefined> {
    const entryArray = [...entries];
    const errors = new Array<Error | undefined>(entryArray.length);

    // TODO: optimize this

    // update indices
    {
      const indexArray = [] as [AttrValueStoreKey<Id, V>, Id | undefined][];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[entityId, field, entryId], value] = entryArray[i];
        if (value !== void 0) {
          indexArray[i] = [[field, value, '', entryId], entityId];
        }
      }

      const deletedKeys = entryArray
        .filter(([, value]) => value === void 0)
        .map(([key]) => key);
      if (deletedKeys.length) {
        let i = 0;
        for await (const value of this.data.getMany(deletedKeys, options)) {
          for (; i < entryArray.length && entryArray[i][1] !== void 0; ++i);
          if (value !== void 0) {
            const [[entityId, field, entryId]] = entryArray[i];
            indexArray[i] = [[field, value, '', entryId], entityId];
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
      const txIds = [] as (Id | undefined)[];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[, , entryId], value] = entryArray[i];
        const isAdd = !errors[i] && entryId !== void 0 && value !== void 0;
        txIds.push(isAdd ? entryId : void 0);
      }
      const addedIds = txIds.filter((id) => id !== void 0) as Id[];
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

  public async *[Symbol.asyncIterator](): AsyncIterator<[EntityAttrKey<Id>, V]> {
    yield* this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return MapEntityStore.name;
  }
}

/** {@link AttrValueKey} with a separator. */
export type AttrValueStoreKey<Id, V> =
  readonly [attr: string, value?: V, separator?: string, txId?: Id];

function getAttrUpperBound(attr: string = TERMINAL, open = true): string {
  if (open) { return attr; }
  const isNamespaced = attr.indexOf('/') >= 0;
  return isNamespaced ? `${attr}\0` : `${attr}/${TERMINAL}`;
}
