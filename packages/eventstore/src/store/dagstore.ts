import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BinaryHeap, ContentAddressedMapStore, EncodedMap, EncodedSet, MaybeAsyncMap,
  MaybeAsyncReadonlySet, MaybeAsyncSet, MaybeAsyncSetBatch
} from '@mithic/collections';
import {
  AbortOptions, CodedError, ContentId, ErrorCode, StringEquatable, SyncOrAsyncIterable, equalsOrSameString,
  operationError
} from '@mithic/commons';
import { DEFAULT_BATCH_SIZE } from '../defaults.js';
import { Event, EventMetadata } from '../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreMetaQueryOptions } from '../store.js';
import { BaseDagEventStore } from './base.js';

/** Default decodeKey implementation that uses multiformats as optional dependency. */
const decodeCID = await (async () => {
  try {
    const { CID } = await import('multiformats');
    return <K>(key: string) => CID.parse(key) as unknown as K;
  } catch (_) {
    return () => { throw operationError('multiformats not available', ErrorCode.InvalidState); };
  }
})();

/** An {@link EventStore} implementation that stores a direct-acyclic graph of content-addressable events. */
export class DagEventStore<
  K extends StringEquatable<K> = ContentId,
  V extends Event<unknown, EventMetadata<K>> = Event<unknown, EventMetadata<K>>
> extends BaseDagEventStore<K, V, EventStoreMetaQueryOptions<K>>
  implements EventStore<K, V, EventStoreMetaQueryOptions<K>>, AsyncIterable<[K, V]>
{
  protected readonly encodeKey: (key: K) => string;
  protected readonly decodeKey: (key: string) => K;
  protected readonly headSet: MaybeAsyncSet<K> & Partial<MaybeAsyncSetBatch<K>> & SyncOrAsyncIterable<K>;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    encodeKey = (key) => `${key}`,
    decodeKey = decodeCID,
    head = new EncodedSet<K, string, Set<string>>(new Set(), encodeKey, decodeKey),
  }: DagEventStoreOptions<K, V> = {}) {
    super(data);
    this.encodeKey = encodeKey;
    this.decodeKey = decodeKey;
    this.headSet = head;
  }

  /** The head event keys. */
  public get heads(): MaybeAsyncReadonlySet<K> & SyncOrAsyncIterable<K> {
    return this.headSet;
  }

  public async validate(value: V, options?: AbortOptions): Promise<CodedError<K[]> | undefined> {
    const error = await super.validate(value, options);
    if (error) {
      return error;
    }

    let latestTime = 0;
    for (const [, parent] of this.currentEventDeps) {
      latestTime = Math.max(latestTime, parent.meta.createdAt || 0);
    }

    if (value.meta.createdAt && latestTime > value.meta.createdAt) {
      return operationError('Invalid event time', ErrorCode.InvalidArg);
    }
  }

  /** Queries entries by given criteria. */
  public async * entries(
    options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>
  ): AsyncGenerator<[K, V], K[]> {
    const headOnly = options?.head || false;
    const limit = options?.limit ?? Infinity;

    // TODO: any way to optimize this?
    // build map of visited keys to their levels
    const visited = new EncodedMap<K, number, string, number, Map<string, number>>(
      new Map(), { encodeKey: this.encodeKey, decodeKey: this.decodeKey }
    );
    if (options?.since?.length) {
      for await (const _ of this.predecessors(options.since, visited, options));
    }

    // retrieve all entries and their levels
    const entries: [key: K, value: V, level: number][] = [];
    {
      const heads = [];
      for await (const key of this.headSet) {
        heads.push(key);
      }
      for await (const entry of this.predecessors(heads, visited, options)) {
        entries.push(entry);
      }
    }

    // Use a priority queue (heap) to return entries in order
    const queue = new BinaryHeap<number>(
      range(entries.length),
      (i, j) => (entries[i][2] - entries[j][2]) ||
        this.encodeKey(entries[i][0]).localeCompare(this.encodeKey(entries[j][0])),
      true
    );
    const heads = new EncodedMap<K, V, string, V, Map<string, V>>(
      new Map(), { encodeKey: this.encodeKey, decodeKey: this.decodeKey }
    );
    for (let count = 0, i = queue.shift(); i !== void 0 && count < limit; i = queue.shift()) {
      const [key, value] = entries[i];

      // yield matching entires. skip if head = true, as we will do this later
      if (!headOnly) {
        yield [key, value];
        ++count;
      }

      // update head set
      heads.set(key, value);
      if (value.meta.parents.length) {
        for await (const error of heads.deleteMany(value.meta.parents, options)) {
          if (error) {
            throw operationError('Failed to update head', ErrorCode.OpFailed, void 0, error);
          }
        }
      }
    }

    // build head list, and yield matching heads if head = true
    const headList = [];
    {
      let count = 0;
      for await (const entry of heads) {
        if (count >= limit) {
          break;
        }
        headList.push(entry[0]);
        if (headOnly && count++ < limit) {
          yield entry;
        }
      }
    }

    return headList;
  }

  protected async prePut(value: V, options?: AbortOptions): Promise<void> {
    const key = await this.getKey(value);

    // update head
    if (value.meta.parents.length && this.headSet.updateMany) {
      for await (const error of this.headSet.updateMany(
        [[key], ...value.meta.parents.map((key) => [key, true] as [K, boolean])], options
      )) {
        if (error) {
          throw operationError('Failed to update head', ErrorCode.OpFailed, void 0, error);
        }
      }
    } else {
      await this.headSet.add(key, options);
      for (const parentKey of value.meta.parents) {
        await this.headSet.delete(parentKey, options);
      }
    }
  }

  /** Traverses the graph of events from given keys and returns the max level. */
  protected async * predecessors(
    keys: readonly K[], visited: MaybeAsyncMap<K, number>,
    options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>,
  ): AsyncIterableIterator<[key: K, value: V, level: number]> {
    for (let i = 0; i < keys.length; i += DEFAULT_BATCH_SIZE) {
      const keyBatch = keys.slice(i, Math.min(i + DEFAULT_BATCH_SIZE, keys.length));
      let j = -1;
      for await (const value of this.getMany(keyBatch, options)) {
        ++j;
        if (value === void 0) {
          continue;
        }

        let level = await visited.get(keyBatch[j], options);
        const keyVisited = level !== void 0;
        level = level || 0;
        if (keyVisited) {
          continue;
        }
        if (!options?.head && value.meta.parents.length) {
          for await (const entry of this.predecessors(value.meta.parents, visited, options)) {
            yield entry;
            level = Math.max(level, entry[2] + 1);
          }
        }
        if (
          (options?.root === void 0 || equalsOrSameString(options.root, value.meta.root ?? keyBatch[j])) &&
          value.type.startsWith(options?.type || '')
        ) {
          yield [keyBatch[j], value, level];
        }
        visited.set(keyBatch[j], level, options);
      }
    }
  }
}

/** Options for creating a {@link DagEventStore}. */
export interface DagEventStoreOptions<K, V> {
  /** Backing data store map. */
  data?: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>;

  /** Head event set. */
  head?: MaybeAsyncSet<K> & Partial<MaybeAsyncSetBatch<K>> & SyncOrAsyncIterable<K>;

  /** Function to encode event key as string. */
  encodeKey?: (key: K) => string;

  /** Function to decode event key string. */
  decodeKey?: (key: string) => K,
}

function* range(length: number): IterableIterator<number> {
  for (let i = 0; i < length; ++i) {
    yield i;
  }
}