import {
  BTreeMap, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable, compareMultiKeys
} from '@mithic/collections';
import { AbortOptions, CodedError, MaybeAsyncIterableIterator, OperationError } from '@mithic/commons';
import { AttrSearchKey, EntityAttrKey, EntityAttrSearchKey, TripleStore } from '../store.js';
import { BaseTripleStore } from '../base.js';

const TERMINAL = '\udbff\udfff';

/** Map-based {@link TripleStore}. */
export class MapTripleStore<Id, V> extends BaseTripleStore<Id, V>
  implements TripleStore<Id, V>, AsyncIterable<[EntityAttrKey<Id>, V]>
{
  public constructor(
    /** Map of data entries. */
    protected readonly data:
      MaybeAsyncMapBatch<EntityAttrKey<Id>, V> & RangeQueryable<EntityAttrKey<Id>, V>
      = new BTreeMap(5, compareMultiKeys),
    /** Map of field value index. */
    protected readonly index:
      MaybeAsyncMapBatch<AttrIndexKey<Id>, Id> & RangeQueryable<AttrIndexKey<Id>, Id>
      = new BTreeMap(5, compareMultiKeys),
    /** Max size of a request batch. */
    protected readonly batchSize = 50,
  ) {
    super();
  }

  public override async * entries(
    options?: RangeQueryOptions<EntityAttrSearchKey<Id>>
  ): AsyncIterableIterator<[EntityAttrKey<Id>, V]> {
    let lower: EntityAttrKey<Id> | undefined, upper: EntityAttrKey<Id> | undefined;
    if (options?.lower) {
      lower = [options.lower[0], options.lower[1] ?? '', options.lower[2] ?? ''];
    }
    if (options?.upper) {
      const open = options.upperOpen ?? true;
      const hasSortKey = options.upper[2] !== void 0;
      const attr = options.upper[1] ?? (open ? '' : TERMINAL);
      upper = [
        options.upper[0],
        open || hasSortKey ? attr : `${attr}\0`,
        open || !hasSortKey ? options.upper[2] ?? TERMINAL : `${options.upper[2]}\0`,
      ];
    }

    for await (const [key, value] of this.data.entries({
      ...options, lower, upper, upperOpen: true,
    })) {
      yield [key, value];
    }
  }

  public override async * keysByAttr(
    options?: RangeQueryOptions<AttrSearchKey>
  ): AsyncIterableIterator<EntityAttrKey<Id>> {
    let upper: AttrIndexKey<Id> | undefined;
    if (options?.upper) {
      const open = options.upperOpen ?? true;
      const hasSortKey = options.upper[1] !== void 0;
      const attr = options.upper[0] ?? (open ? '' : TERMINAL);
      upper = [
        open || hasSortKey ? attr : `${attr}\0`,
        open || !hasSortKey ? options.upper[1] ?? TERMINAL : `${options.upper[1]}\0`,
      ];
    }

    for await (const [[attr, tag, txId], entityId] of this.index.entries({
      ...options, lower: options?.lower, upper, upperOpen: true,
    })) {
      yield [entityId, attr, tag ?? '', txId];
    }
  }

  public override async * entriesByAttr(
    options?: RangeQueryOptions<AttrSearchKey>
  ): AsyncIterableIterator<[EntityAttrKey<Id>, V]> {
    let keys = [];
    for await (const key of this.keysByAttr(options)) {
      keys.push(key);
      if (keys.length >= this.batchSize) {
        yield* this.getEntriesMany(keys, options);
        keys = [];
      }
    }
    if (keys.length) {
      yield* this.getEntriesMany(keys, options);
    }
  }

  public override * findMany(
    keys: Iterable<EntityAttrSearchKey<Id>>, options?: AbortOptions
  ): IterableIterator<AsyncIterableIterator<[EntityAttrKey<Id>, V]>> {
    for (const key of keys) {
      yield this.entries({ lower: key, upper: key, upperOpen: false, signal: options?.signal });
    }
  }

  public override * findManyByAttr(
    keys: Iterable<AttrSearchKey>, options?: AbortOptions
  ): IterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>> {
    for (const key of keys) {
      yield this.entriesByAttr({ lower: key, upper: key, upperOpen: false, signal: options?.signal });
    }
  }

  public override getMany(
    keys: Iterable<EntityAttrKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<V | undefined> {
    return this.data.getMany(keys, options);
  }

  public override async * updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<Id>, value?: V]>, options?: AbortOptions
  ): AsyncIterableIterator<CodedError<EntityAttrKey<Id>> | undefined> {
    const entryArray = [...entries];
    const errors = new Array<Error | undefined>(entryArray.length);

    // TODO: optimize this

    // update indices
    {
      const indexArray = [] as [AttrIndexKey<Id>, Id | undefined][];
      for (let i = 0; i < entryArray.length; ++i) {
        const [[entityId, attr, tag, txId], value] = entryArray[i];
        if (value !== void 0) {
          indexArray[i] = [[attr, tag, txId], entityId];
        }
      }

      const deletedKeys = entryArray.filter(([, value]) => value === void 0).map(([key]) => key);
      if (deletedKeys.length) {
        let i = 0;
        for await (const value of this.data.getMany(deletedKeys, options)) {
          for (; i < entryArray.length && entryArray[i][1] !== void 0; ++i);
          if (value !== void 0) {
            const [[entityId, attr, tag, txId]] = entryArray[i];
            indexArray[i] = [[attr, tag, txId], entityId];
          }
          ++i;
        }
      }

      const indices = indexArray.filter((entry) => !!entry);
      if (indices.length) {
        let i = 0;
        for await (const error of this.index.updateMany(indices, options)) {
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

    {
      let i = 0;
      for (const error of errors) {
        yield error ? new OperationError('failed to update', { detail: entryArray[i][0], cause: error }) : void 0;
        ++i;
      }
    }
  }

  public override get [Symbol.toStringTag](): string {
    return MapTripleStore.name;
  }

  private async * getEntriesMany(
    keys: EntityAttrKey<Id>[], options?: AbortOptions
  ): AsyncIterableIterator<[EntityAttrKey<Id>, V]> {
    let i = 0;
    for await (const value of this.data.getMany(keys, options)) {
      if (value !== void 0) { yield [keys[i], value]; }
      ++i;
    }
  }
}

/** Tagged attribute index key. */
export type AttrIndexKey<Id> = readonly [attr: string, tag?: string, txId?: Id];
