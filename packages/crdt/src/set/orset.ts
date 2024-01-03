import {
  MaybeAsyncReadonlySet, MaybeAsyncReadonlySetBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, MaybePromise, ToString } from '@mithic/commons';
import { defaultHash } from '../defaults.js';
import {
  MapCommand, MapCommandHandler, MapCommandType, MapEvent, MapEventOp, MapEventType, MapProjection,
  ORMapCommandHandler, ORMapProjection
} from '../map/index.js';
import {
  EntityAttrSearchKey, EntityStoreProvider, ReadonlyEntityStore, ReadonlyEntityStoreProvider
} from '../store/index.js';
import { SetCommand, SetCommandHandler, SetEvent, SetEventOp, SetEventType, SetProjection } from './set.js';

const DEFAULT_NAMESPACE = '$val';

/** Observed-removed multiset command handler. */
export class ORSetCommandHandler<Id extends ToString = ContentId, V = unknown> implements SetCommandHandler<Id, V> {
  public constructor(
    /** {@link MapCommandHandler} instance. */
    protected readonly mapCommandHandler: MapCommandHandler<Id, V> = new ORMapCommandHandler(),
    /** Function for converting value to hash string. Defaults to `JSON.stringify`. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
  ) {
  }

  public async handle(
    storeProvider: ReadonlyEntityStoreProvider<Id, V>, command: SetCommand<Id, V>, options?: AbortOptions
  ): Promise<SetEvent<Id, V> | undefined> {
    const namespace = command.payload.ns || DEFAULT_NAMESPACE;
    const type = command.root === void 0 ? SetEventType.New : SetEventType.Update;
    const values: Record<string, V> = {};
    const put: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<Id, V> = {
      ...command,
      type: MapCommandType.Update,
      payload: { put, del, type: command.payload.type },
    };

    for (const value of command.payload.del || []) {
      const key = await this.keyOf(namespace, value, options);
      values[key] = value;
      del.push(key);
    }
    for (const value of command.payload.add || []) {
      const key = await this.keyOf(namespace, value, options);
      values[key] = value;
      put[key] = value;
    }

    const mapEvent = await this.mapCommandHandler.handle(storeProvider, mapCmd, options);
    if (!mapEvent) { return; }

    const ops: SetEventOp<V>[] = [];
    for (const [key, value, ...parents] of mapEvent.payload.set) {
      ops.push([values[key], value !== null, ...parents]);
    }

    return {
      ...mapEvent,
      type,
      payload: { set: ops, type: command.payload.type, ns: namespace },
    };
  }

  protected keyOf(namespace: string, value?: V, options?: AbortOptions): Promise<string> {
    return keyOf(this.hash, namespace, value, options);
  }
}

/** Observed-removed multiset projection. */
export class ORSetProjection<Id = ContentId, V = unknown> implements SetProjection<Id, V> {
  public constructor(
    /** {@link MapProjection} instance. */
    protected readonly mapProjection: MapProjection<Id, V> = new ORMapProjection(),
    /** Function for converting value to hash string. Defaults to `JSON.stringify`. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
  ) {
  }

  public async reduce(
    storeProvider: EntityStoreProvider<Id, V>, event: SetEvent<Id, V>, options?: AbortOptions
  ): Promise<EntityStoreProvider<Id, V>> {
    await this.mapProjection.reduce(storeProvider, await toMapEvent(event, this.keyOf, options), options);
    return storeProvider;
  }

  public async validate(
    storeProvider: EntityStoreProvider<Id, V>, event: SetEvent<Id, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    return this.mapProjection.validate(storeProvider, await toMapEvent(event, this.keyOf, options), options);
  }

  protected keyOf = (namespace: string, value?: V, options?: AbortOptions): Promise<string> => {
    return keyOf(this.hash, namespace, value, options);
  };
}

/** Readonly observed-removed map. */
export class ReadonlyORSet<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlySet<V>, MaybeAsyncReadonlySetBatch<V>, RangeQueryable<V, V>, AsyncIterable<V>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyEntityStore<Id, V>,
    /** The set entity ID. */
    public readonly entityId: Id,
    /** Function for converting value to hash string. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
    /** Namespace for value hash keys. Defaults to `$val`. */
    public readonly namespace = DEFAULT_NAMESPACE,
  ) { }

  public async has(value: V, options?: AbortOptions): Promise<boolean> {
    const key = await this.keyOf(value, options);
    for await (const _ of this.store.entries({
      ...options,
      lower: [this.entityId, key],
      upper: [this.entityId, key],
      upperOpen: false,
      limit: 1,
    })) {
      return true;
    }
    return false;
  }

  public async * hasMany(keys: Iterable<V>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    const entityKeys: [Id, string][] = [];
    for (const key of keys) {
      entityKeys.push([this.entityId, await this.keyOf(key, options)]);
    }

    for await (const iter of this.store.findMany(entityKeys, options)) {
      yield !(await iter.next()).done;
    }
  }

  public async * keys(options?: RangeQueryOptions<V>): AsyncIterableIterator<V> {
    const lower: EntityAttrSearchKey<Id> = [this.entityId, await this.keyOf(options?.lower, options)];
    let upper: EntityAttrSearchKey<Id> = this.namespace ? [this.entityId, this.namespace] : [this.entityId];
    let upperOpen = false;
    if (options?.upper !== void 0) {
      upper = [this.entityId, await this.keyOf(options.upper, options)];
      upperOpen = options.upperOpen ?? true;
    }

    for await (const [, value] of this.store.entries({ ...options, lower, upper, upperOpen })) {
      yield value;
    }
  }

  public values(options?: RangeQueryOptions<V>): AsyncIterableIterator<V> {
    return this.keys(options);
  }

  public async * entries(options?: RangeQueryOptions<V>): AsyncIterableIterator<[V, V]> {
    for await (const key of this.keys(options)) { yield [key, key]; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<V> {
    return this.values();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyORSet.name;
  }

  protected keyOf(value?: V, options?: AbortOptions): Promise<string> {
    return keyOf(this.hash, this.namespace, value, options);
  }
}

/** Converts a set event to a map event. */
async function toMapEvent<K, V>(
  event: SetEvent<K, V>,
  keyOf: (namespace: string, value: V, options?: AbortOptions) => MaybePromise<string>,
  options?: AbortOptions
): Promise<MapEvent<K, V>> {
  const ops: MapEventOp<V>[] = [];
  for (const [value, isAdd, ...parents] of event.payload.set) {
    const field = await keyOf(event.payload.ns ?? '', value, options);
    ops.push([field, isAdd ? value : null, ...parents]);
  }

  return {
    ...event,
    type: event.type === SetEventType.New ? MapEventType.New : MapEventType.Update,
    payload: { set: ops, type: event.payload.type },
  };
}

async function keyOf<V>(
  hashFn: (value: V, options?: AbortOptions) => MaybePromise<string>,
  namespace: string,
  value?: V,
  options?: AbortOptions
): Promise<string> {
  const hash = value !== void 0 ? await hashFn(value, options) : '';
  return namespace ? `${namespace}/${hash}` : hash;
}
