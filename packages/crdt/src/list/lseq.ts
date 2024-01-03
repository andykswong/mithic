import {
  MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, MaybePromise, ToString } from '@mithic/commons';
import {
  MapCommand, MapCommandHandler, MapCommandType, MapEvent, MapEventType, MapProjection,
  ORMapCommandHandler, ORMapProjection
} from '../map/index.js';
import { EntityAttrSearchKey, EntityStoreProvider, ReadonlyEntityStore, ReadonlyEntityStoreProvider } from '../store/index.js';
import { FractionalIndexGenerator, IndexGenerator } from '../utils/index.js';
import { ListCommand, ListCommandHandler, ListEvent, ListEventType, ListProjection } from './list.js';

const DEFAULT_NAMESPACE = '$idx';

/** LSeq command handler. */
export class LSeqCommandHandler<Id extends ToString = ContentId, V = unknown> implements ListCommandHandler<Id, V> {
  public constructor(
    /** {@link MapCommandHandler} instance. */
    protected readonly mapCommandHandler: MapCommandHandler<Id, V> = new ORMapCommandHandler(),
    /** {@link IndexGenerator} instance. */
    protected readonly generator: IndexGenerator<string> = new FractionalIndexGenerator(),
  ) {
  }

  public async handle(
    storeProvider: ReadonlyEntityStoreProvider<Id, V>, command: ListCommand<Id, V>, options?: AbortOptions
  ): Promise<ListEvent<Id, V> | undefined> {
    const store = await storeProvider(command.payload.type);
    const namespace = command.payload.ns ?? DEFAULT_NAMESPACE;
    const type = command.root === void 0 ? ListEventType.New : ListEventType.Update;
    const deleteCount = type === ListEventType.New ? 0 : command.payload.del || 0;
    const put: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<Id, V> = {
      ...command,
      type: MapCommandType.Update,
      payload: { put, del, type: command.payload.type },
    };

    // add before given index
    if (command.payload.add?.length) {
      let startIndex: string | undefined;
      const endIndex = command.payload.index;

      if (command.root) { // try to find an index before given index to insert in between
        for await (const [[, key]] of store.entries({
          lower: [command.root, keyOf(namespace)],
          upper: endIndex !== void 0 ? [command.root, keyOf(namespace, endIndex)] :
            namespace ? [command.root, namespace] : [command.root],
          upperOpen: endIndex !== void 0,
          limit: 1,
          reverse: true,
          signal: options?.signal,
        })) {
          startIndex = indexOf(namespace, key);
          break;
        }
      }

      let i = 0;
      for (const index of this.generator.create(startIndex, endIndex, command.payload.add.length)) {
        put[keyOf(namespace, index)] = command.payload.add[i++];
      }
    }

    // delete after given index
    if (command.root && deleteCount) {
      const deletedIndices = new Set<string>();
      for await (const [[, key]] of store.entries({
        lower: [command.root, keyOf(namespace, command.payload.index)],
        upper: namespace ? [command.root, namespace] : [command.root],
        upperOpen: false,
        limit: deleteCount,
        signal: options?.signal,
      })) {
        deletedIndices.add(key);
      }
      del.push(...deletedIndices);
    }

    const mapEvent = await this.mapCommandHandler.handle(storeProvider, mapCmd, options);
    if (!mapEvent) { return; }

    return {
      ...mapEvent,
      type,
      payload: {
        set: mapEvent.payload.set.map(([key, ...valDep]) => [indexOf(namespace, key), ...valDep]),
        type: command.payload.type,
        ns: namespace,
      }
    };
  }
}

/** LSeq projection. */
export class LSeqProjection<Id = ContentId, V = unknown> implements ListProjection<Id, V> {
  public constructor(
    protected readonly mapProjection: MapProjection<Id, V> = new ORMapProjection(),
    /** {@link IndexGenerator} instance. */
    protected readonly generator: IndexGenerator<string> = new FractionalIndexGenerator(),
  ) {
  }

  public reduce(
    storeProvider: EntityStoreProvider<Id, V>, event: ListEvent<Id, V>, options?: AbortOptions
  ): MaybePromise<EntityStoreProvider<Id, V>> {
    return this.mapProjection.reduce(storeProvider, toMapEvent(event), options);
  }

  public async validate(
    storeProvider: EntityStoreProvider<Id, V>, event: ListEvent<Id, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    const error = await this.mapProjection.validate(storeProvider, toMapEvent(event), options);
    if (error) {
      return error;
    }

    for (const op of event.payload.set) {
      if (!this.generator.validate(op[0])) {
        return new TypeError(`Invalid index: ${op[0]}`);
      }
    }
  }
}

/** Readonly observed-removed map. */
export class ReadonlyLSeq<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlyMap<string, V>, MaybeAsyncReadonlyMapBatch<string, V>,
  RangeQueryable<string, V>, AsyncIterable<V>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyEntityStore<Id, V>,
    /** The set entity ID. */
    public readonly entityId: Id,
    /** Namespace for index keys. Defaults to `$idx`. */
    public readonly namespace = DEFAULT_NAMESPACE,
  ) { }

  public async get(index: string, options?: AbortOptions): Promise<V | undefined> {
    for await (const [, value] of this.store.entries({
      ...options,
      lower: [this.entityId, keyOf(this.namespace, index)],
      upper: [this.entityId, keyOf(this.namespace, index)],
      upperOpen: false,
      limit: 1,
    })) {
      return value;
    }
  }

  public async has(index: string, options?: AbortOptions): Promise<boolean> {
    return (await this.get(index, options)) !== void 0;
  }

  public async * getMany(indices: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    const entityKeys: [Id, string][] = [];
    for (const index of indices) {
      entityKeys.push([this.entityId, keyOf(this.namespace, index)]);
    }

    for await (const iter of this.store.findMany(entityKeys, options)) {
      const result = await iter.next();
      yield result.done ? void 0 : result.value[1];
    }
  }

  public async * hasMany(indices: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    const entityKeys: [Id, string][] = [];
    for (const index of indices) {
      entityKeys.push([this.entityId, keyOf(this.namespace, index)]);
    }

    for await (const iter of this.store.findMany(entityKeys, options)) {
      yield !(await iter.next()).done;
    }
  }

  public async * entries(options?: RangeQueryOptions<string>): AsyncIterableIterator<[string, V]> {
    const lower: EntityAttrSearchKey<Id> = [this.entityId, keyOf(this.namespace, options?.lower)];
    let upper: EntityAttrSearchKey<Id> = this.namespace ? [this.entityId, this.namespace] : [this.entityId];
    let upperOpen = false;
    if (options?.upper !== void 0) {
      upper = [this.entityId, keyOf(this.namespace, options.upper)];
      upperOpen = options.upperOpen ?? true;
    }

    for await (const [[, key], value] of this.store.entries({ ...options, lower, upper, upperOpen })) {
      yield [indexOf(this.namespace, key), value];
    }
  }

  public async * keys(options?: RangeQueryOptions<string>): AsyncIterableIterator<string> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<string>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<V> {
    return this.values();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyLSeq.name;
  }
}

function toMapEvent<Id, V>(event: ListEvent<Id, V>,): MapEvent<Id, V> {
  return {
    ...event,
    type: event.type === ListEventType.New ? MapEventType.New : MapEventType.Update,
    payload: {
      ...event.payload,
      set: event.payload.set.map(
        ([index, ...valDep]) => [keyOf(event.payload.ns ?? '', index), ...valDep]
      ),
    }
  };
}

function keyOf(namespace: string, index: string = ''): string {
  return namespace ? `${namespace}/${index}` : index;
}

function indexOf(namespace: string, key: string): string {
  if (namespace && key.startsWith(namespace + '/')) {
    return key.substring(namespace.length + 1);
  }
  return key;
}
