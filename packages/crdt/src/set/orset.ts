import { AbortOptions, ContentId, MaybePromise, ToString } from '@mithic/commons';
import {
  MapCommand, MapCommandHandler, MapCommandType, MapEvent, MapEventOp, MapEventType, MapProjection, MapRangeQueryResolver,
  ORMapCommandHandler, ORMapProjection, ORMapRangeQueryResolver
} from '../map/index.js';
import {
  SetCommand, SetCommandHandler, SetEvent, SetEventOp, SetEventType, SetProjection, SetRangeQuery, SetRangeQueryResolver
} from './set.js';
import { defaultHash } from '../defaults.js';
import { MapStore, ReadonlyMapStore } from '../store.js';

/** Observed-removed multiset command handler. */
export class ORSetCommandHandler<K extends ToString = ContentId, V = unknown> implements SetCommandHandler<K, V> {
  public constructor(
    /** {@link MapCommandHandler} instance. */
    protected readonly mapCommandHandler: MapCommandHandler<K, V> = new ORMapCommandHandler(),
    /** Function for converting value to hash string. Defaults to `JSON.stringify`. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
  ) {
  }

  public async handle(
    store: ReadonlyMapStore<K, V>, command: SetCommand<K, V>, options?: AbortOptions
  ): Promise<SetEvent<K, V> | undefined> {
    const type = command.root === void 0 ? SetEventType.New : SetEventType.Update;
    const values: Record<string, V> = {};
    const put: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<K, V> = {
      ...command,
      type: MapCommandType.Update,
      payload: { put, del },
    };

    for (const value of command.payload.del || []) {
      const hash = await this.hash(value, options);
      values[hash] = value;
      del.push(hash);
    }
    for (const value of command.payload.add || []) {
      const hash = await this.hash(value, options);
      values[hash] = value;
      put[hash] = value;
    }

    const mapEvent = await this.mapCommandHandler.handle(store, mapCmd, options);
    if (mapEvent === void 0) {
      return;
    }

    const ops: SetEventOp<V>[] = [];
    for (const [hash, value, ...parents] of mapEvent.payload.set) {
      ops.push([values[hash], value !== null, ...parents]);
    }

    return {
      ...mapEvent,
      type,
      payload: { set: ops },
    };
  }
}

/** Observed-removed multiset projection. */
export class ORSetProjection<K = ContentId, V = unknown> implements SetProjection<K, V> {
  public constructor(
    /** {@link MapProjection} instance. */
    protected readonly mapProjection: MapProjection<K, V> = new ORMapProjection(),
    /** Function for converting value to hash string. Defaults to `JSON.stringify`. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
  ) {
  }

  public async reduce(store: MapStore<K, V>, event: SetEvent<K, V>, options?: AbortOptions): Promise<MapStore<K, V>> {
    await this.mapProjection.reduce(store, await toMapEvent(event, this.hash, options), options);
    return store;
  }

  public async validate(
    store: MapStore<K, V>, event: SetEvent<K, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    return this.mapProjection.validate(store, await toMapEvent(event, this.hash, options), options);
  }
}

/** Observed-removed multiset range query resolver. */
export class ORSetRangeQueryResolver<K extends ToString = ContentId, V = unknown>
  implements SetRangeQueryResolver<K, V>
{
  public constructor(
    /** {@link MapRangeQueryResolver} instance. */
    protected readonly mapQueryResolver: MapRangeQueryResolver<K, V> = new ORMapRangeQueryResolver(),
    /** Function for converting value to hash string. Defaults to `JSON.stringify`. */
    protected readonly hash: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultHash,
  ) { }

  public async * resolve(
    store: ReadonlyMapStore<K, V>, query: SetRangeQuery<K, V>, options?: AbortOptions
  ): AsyncIterable<V> {
    const lower = query.lower && await this.hash(query.lower, options);
    const upper = query.upper && await this.hash(query.upper, options);

    for await (const [_hash, value] of this.mapQueryResolver.resolve(store, {
      lower, upper, lowerOpen: query.lowerOpen, upperOpen: query.upperOpen,
      root: query.root, reverse: query.reverse, limit: query.limit,
    }, options)) {
      yield value as V;
    }
  }
}

/** Converts a set event to a map event. */
async function toMapEvent<K, V>(
  event: SetEvent<K, V>,
  hash: (value: V, options?: AbortOptions) => MaybePromise<string>,
  options?: AbortOptions
): Promise<MapEvent<K, V>> {
  const ops: MapEventOp<V>[] = [];
  for (const [value, isAdd, ...parents] of event.payload.set) {
    const field = await hash(value, options);
    ops.push([field, isAdd ? value : null, ...parents]);
  }

  return {
    ...event,
    type: event.type === SetEventType.New ? MapEventType.New : MapEventType.Update,
    payload: { set: ops },
  };
}
