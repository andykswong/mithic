import { rangeQueryable } from '@mithic/collections';
import { AbortOptions, ContentId, MaybeAsyncIterableIterator, MaybePromise, ToString } from '@mithic/commons';
import { EntityAttrKey } from '@mithic/triplestore';
import {
  ReadonlyEntityCollection, EntityView, EntityAttrLookup, EntityTypeOptions, EntityViewOptions,
  EntityRangeQueryOptions, EntityAttrRangeQueryOptions, EntityAttrReducer
} from './entity.js';
import { defaultStringify } from '../defaults.js';
import { ReadonlyEntityStore } from '../store.js';

const ID_FIELD = '$id';
const TERMINAL = '\udbff\udfff';

/** Observed-removed {@link ReadonlyEntityCollection}. */
export class ReadonlyOREntityCollection<
  Id extends ToString = ContentId, V = string | number | Id
> implements ReadonlyEntityCollection<Id, V>, AsyncIterable<[Id, EntityView<V>]> {
  public constructor(
    /** The store state. */
    protected readonly state: ReadonlyEntityStore<Id, V>,
    /** Function for converting value to string. */
    protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultStringify,
    /** Max size of a request batch. */
    protected readonly batchSize = 50,
  ) { }

  public async * getMany<L extends EntityAttrLookup<V>>(
    ids: Iterable<Id>, options?: EntityViewOptions<V, L>
  ): MaybeAsyncIterableIterator<EntityView<V, L> | undefined> {
    const store = this.state.store(options?.type);
    outer: for await (const iter of store.findMany([...ids].map(id => [id]), options)) {
      for await (const [, view] of this.collect(iter, options?.attr)) {
        yield view;
        continue outer;
      }
      yield;
    }
  }

  public async get<L extends EntityAttrLookup<V>>(
    id: Id, options?: EntityViewOptions<V, L>
  ): Promise<EntityView<V, L> | undefined> {
    for await (const result of this.getMany([id], options)) { return result; }
  }

  public async has(id: Id, options?: EntityTypeOptions): Promise<boolean> {
    return (await this.get(id, options)) !== void 0;
  }

  public async * hasMany(ids: Iterable<Id>, options?: EntityTypeOptions): AsyncIterableIterator<boolean> {
    for await (const result of this.getMany(ids, options)) { yield result !== void 0; }
  }

  public async * entries<L extends EntityAttrLookup<V>>(
    options: EntityRangeQueryOptions<Id, V, L> = {}
  ): AsyncIterableIterator<[Id, EntityView<V, L>]> {
    const { type, attr, lower, upper, limit = Infinity, ...rangeOps } = options;
    const store = this.state.store(type);
    let i = 0;
    for await (const entry of this.collect(store.entries({
      ...rangeOps,
      lower: lower !== void 0 ? rangeOps?.lowerOpen ? [lower, TERMINAL] : [lower] : void 0,
      upper: upper !== void 0 ? [upper] : void 0,
    }), attr)) {
      if (i++ >= limit) { break; }
      yield entry;
    }
  }

  public async * keys<L extends EntityAttrLookup<V>>(
    options?: EntityRangeQueryOptions<Id, V, L>
  ): AsyncIterableIterator<Id> {
    for await (const [id] of this.entries(options)) { yield id; }
  }

  public async * values<L extends EntityAttrLookup<V>>(
    options?: EntityRangeQueryOptions<Id, V, L>
  ): AsyncIterableIterator<EntityView<V, L>> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public async * keysByAttr<L extends EntityAttrLookup<V>>(
    options: EntityAttrRangeQueryOptions<V, L> = {}
  ): AsyncIterableIterator<Id> {
    const { type, attr: _, by = ID_FIELD, lower, upper, limit = Infinity, ...rangeOps } = options;
    if (by === ID_FIELD) {
      yield* this.keys(options as EntityRangeQueryOptions<Id, V, L>);
      return;
    }

    const store = this.state.store(type);
    const seenIds = new Set<string>();
    for await (const [id] of store.keysByAttr({
      ...rangeOps,
      lower: lower !== void 0 ? [by, await this.stringify(lower, options)] : [by],
      upper: upper !== void 0 ? [by, await this.stringify(upper, options)] : [by],
    })) {
      if (seenIds.size >= limit) { break; }
      const idStr = `${id}`;
      if (!seenIds.has(idStr)) {
        yield id;
        seenIds.add(idStr);
      }
    }
  }

  public async * entriesByAttr<L extends EntityAttrLookup<V>>(
    options?: EntityAttrRangeQueryOptions<V, L>
  ): AsyncIterableIterator<[Id, EntityView<V, L>]> {
    if ((options?.by ?? ID_FIELD) === ID_FIELD) {
      yield* this.entries(options as EntityRangeQueryOptions<Id, V, L>);
      return;
    }

    const ids: Id[] = [];
    for await (const id of this.keysByAttr(options)) {
      ids.push(id);
      if (ids.length >= this.batchSize) {
        yield* this.getEntriesMany(ids, options);
        ids.length = 0;
      }
    }
    if (ids.length) {
      yield* this.getEntriesMany(ids, options);
    }
  }

  public async * valuesByAttr<L extends EntityAttrLookup<V>>(
    options?: EntityAttrRangeQueryOptions<V, L>
  ): AsyncIterableIterator<EntityView<V, L>> {
    for await (const [, value] of this.entriesByAttr(options)) { yield value; }
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[Id, EntityView<V>]> {
    return this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyOREntityCollection.name;
  }

  public async * getEntriesMany<L extends EntityAttrLookup<V>>(
    ids: Id[], options?: EntityViewOptions<V, L>
  ): MaybeAsyncIterableIterator<[Id, EntityView<V, L>]> {
    let i = 0;
    for await (const view of this.getMany(ids, options)) {
      if (view) { yield [ids[i], view]; }
      ++i;
    }
  }

  protected async * collect<L extends EntityAttrLookup<V>>(
    iter: MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>, attrs?: L
  ): AsyncIterableIterator<[Id, EntityView<V, L>]> {
    let lastIdStr: string | undefined;
    let lastId: Id | undefined;
    let results: Record<string, unknown> = {};
    let i = 0;

    for await (const [[id, attr, tag], value] of iter) {
      const idStr = `${id}`;
      if (lastIdStr !== idStr) {
        if (i) { yield [lastId as Id, results as EntityView<V, L>]; }
        lastIdStr = idStr;
        lastId = id;
        results = {};
        i = 0;
      }

      if (attrs?.[attr] instanceof Function) {
        results[attr] = (attrs[attr] as EntityAttrReducer<V>)(results[attr], value, attr, tag);
        ++i;
      } else if (results[attr] === void 0 && (!attrs || !!attrs[attr])) {
        results[attr] = value;
        ++i;
      }
    }

    if (i) { yield [lastId as Id, results as EntityView<V, L>]; }
  }
}
