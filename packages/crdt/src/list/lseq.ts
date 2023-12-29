import { AbortOptions, ContentId, MaybePromise, SyncOrAsyncIterable, ToString } from '@mithic/commons';
import {
  MapCommand, MapCommandHandler, MapCommandType, MapEvent, MapEventType, MapProjection, MapRangeQueryResolver,
  ORMapCommandHandler, ORMapProjection, ORMapRangeQueryResolver
} from '../map/index.js';
import { EntityStore, ReadonlyEntityStore } from '../store/index.js';
import { FractionalIndexGenerator, IndexGenerator } from '../utils/index.js';
import {
  ListCommand, ListCommandHandler, ListEvent, ListEventType, ListProjection, ListRangeQuery, ListRangeQueryResolver
} from './list.js';

/** LSeq command handler. */
export class LSeqCommandHandler<K extends ToString = ContentId, V = unknown> implements ListCommandHandler<K, V> {
  public constructor(
    /** {@link MapCommandHandler} instance. */
    protected readonly mapCommandHandler: MapCommandHandler<K, V> = new ORMapCommandHandler(),
    /** {@link IndexGenerator} instance. */
    protected readonly generator: IndexGenerator<string> = new FractionalIndexGenerator(),
  ) {
  }

  public async handle(
    store: ReadonlyEntityStore<K, V>, command: ListCommand<K, V>, options?: AbortOptions
  ): Promise<ListEvent<K, V> | undefined> {
    const type = command.root === void 0 ? ListEventType.New : ListEventType.Update;
    const deleteCount = type === ListEventType.New ? 0 : command.payload.del || 0;
    const put: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<K, V> = {
      ...command,
      type: MapCommandType.Update,
      payload: { put, del },
    };

    // add before given index
    if (command.payload.add?.length) {
      let startIndex: string | undefined = void 0;
      const endIndex = command.payload.index;

      if (command.root) { // try to find an index before given index to insert in between
        for await (const [, index] of store.keys({
          upper: endIndex === void 0 ? void 0 : [command.root, endIndex],
          limit: 1,
          reverse: true,
          signal: options?.signal,
        })) {
          startIndex = index;
          break;
        }
      }

      let i = 0;
      for (const index of this.generator.create(startIndex, endIndex, command.payload.add.length)) {
        put[index] = command.payload.add[i++];
      }
    }

    // delete after given index
    if (command.root && deleteCount) {
      const deletedIndices = new Set<string>();
      for await (const [, index] of store.keys({
        lower: [command.root, command.payload.index ?? ''],
        limit: deleteCount,
        signal: options?.signal,
      })) {
        deletedIndices.add(index);
      }
      del.push(...deletedIndices);
    }

    const mapEvent = await this.mapCommandHandler.handle(store, mapCmd, options);
    if (!mapEvent) {
      return;
    }

    return { ...mapEvent, type };
  }
}

/** LSeq projection. */
export class LSeqProjection<K = ContentId, V = unknown> implements ListProjection<K, V> {
  public constructor(
    protected readonly mapProjection: MapProjection<K, V> = new ORMapProjection(),
    /** {@link IndexGenerator} instance. */
    protected readonly generator: IndexGenerator<string> = new FractionalIndexGenerator(),
  ) {
  }

  public reduce(
    store: EntityStore<K, V>, event: ListEvent<K, V>, options?: AbortOptions
  ): MaybePromise<EntityStore<K, V>> {
    return this.mapProjection.reduce(store, toMapEvent(event), options);
  }

  public async validate(
    store: EntityStore<K, V>, event: ListEvent<K, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    const error = await this.mapProjection.validate(store, toMapEvent(event), options);
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

/** LSeq range query resolver. */
export class LSeqRangeQueryResolver<K extends ToString = ContentId, V = unknown> implements ListRangeQueryResolver<K, V> {
  public constructor(
    protected readonly mapQueryResolver: MapRangeQueryResolver<K, V> = new ORMapRangeQueryResolver(),
  ) { }

  public resolve(
    store: ReadonlyEntityStore<K, V>, query: ListRangeQuery<K, V>, options?: AbortOptions
  ): SyncOrAsyncIterable<[index: string, value: V]> {
    return this.mapQueryResolver.resolve(store, query, options);
  }
}

function toMapEvent<K, V>(event: ListEvent<K, V>): MapEvent<K, V> {
  return {
    ...event,
    type: event.type === ListEventType.New ? MapEventType.New : MapEventType.Update
  };
}
