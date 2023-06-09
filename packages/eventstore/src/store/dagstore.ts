import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BinaryHeap, ContentAddressedMapStore, EncodedMap, EncodedSet, MaybeAsyncMap,
  MaybeAsyncReadonlySet, MaybeAsyncSet, MaybeAsyncSetBatch
} from '@mithic/collections';
import {
  AbortOptions, ContentId, ErrorCode, StringEquatable, SyncOrAsyncIterable, equalsOrSameString, operationError
} from '@mithic/commons';
import { CID } from 'multiformats';
import { DEFAULT_BATCH_SIZE } from '../defaults.js';
import { Event, EventMetadata } from '../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreQueryOptionsExt } from '../store.js';
import { BaseMapEventStore } from './mapstore.js';

/** An {@link EventStore} implementation that stores a direct-acyclic graph of content-addressable events. */
export class DagEventStore<
  K extends StringEquatable<K> = ContentId,
  V extends Event<unknown, EventMetadata<K>> = Event<unknown, EventMetadata<K>>
> extends BaseMapEventStore<K, V, EventStoreQueryOptionsExt<K>>
  implements EventStore<K, V, EventStoreQueryOptionsExt<K>>, AsyncIterable<[K, V]>
{
  protected readonly encodeKey: (key: K) => string;
  protected readonly decodeKey: (key: string) => K;
  protected readonly headSet: MaybeAsyncSet<K> & Partial<MaybeAsyncSetBatch<K>> & SyncOrAsyncIterable<K>;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    encodeKey = (key) => `${key}`,
    decodeKey = (key) => CID.parse(key) as unknown as K,
    head = new EncodedSet<K, string, Set<string>>(new Set(), encodeKey, decodeKey),
  }: DagEventStoreOptions<K, V> = {}) {
    super(data);
    this.encodeKey = encodeKey;
    this.decodeKey = decodeKey;
    this.headSet = head;
  }

  /** The head event keys. */
  public get head(): MaybeAsyncReadonlySet<K> & SyncOrAsyncIterable<K> {
    return this.headSet;
  }

  public async put(value: V, options?: AbortOptions): Promise<K> {
    const key = await this.data.getKey(value, options);
    if (await this.data.has(key, options)) {
      return key;
    }

    // TODO: share parent validation code with SimpleEventStore
    if (value.meta.parents.length) {
      const rootId = value.meta.root;
      if (!rootId) { // root Id must be specified if there are dependencies
        throw operationError('Missing root Id', ErrorCode.InvalidArg);
      }

      const missing: K[] = [];
      let hasMatchingParentRoot = false;
      let i = 0;
      for await (const parent of this.getMany(value.meta.parents, options)) {
        const key = value.meta.parents[i++];
        if (!parent) {
          missing.push(key);
          continue;
        }
        hasMatchingParentRoot = hasMatchingParentRoot || equalsOrSameString(rootId, parent.meta.root ?? key);
      }

      if (missing.length) {
        throw operationError('Missing dependencies', ErrorCode.MissingDep, missing);
      }

      if (!hasMatchingParentRoot) { // root Id must match one of parents' root
        throw operationError('Invalid root Id', ErrorCode.InvalidArg);
      }
    }

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

    // save event
    return super.put(value, options);
  }

  /** Queries entries by given criteria. */
  public async * entries(
    options?: EventStoreQueryOptions<K> & EventStoreQueryOptionsExt<K>
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
      if (!headOnly && value.type.startsWith(options?.type || '')) {
        yield [key, value];
        ++count;
      }

      // update head set
      heads.set(key, value);
      if (value.meta.parents.length && heads.deleteMany) {
        for await (const error of heads.deleteMany(value.meta.parents, options)) {
          if (error) {
            throw operationError('Failed to update head', ErrorCode.OpFailed, void 0, error);
          }
        }
      } else {
        for (const key of value.meta.parents) {
          await heads.delete(key, options);
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
        if (headOnly && entry[1].type.startsWith(options?.type || '') && count++ < limit) {
          yield entry;
        }
      }
    }

    return headList;
  }

  /** Traverses the graph of events from given keys and returns the max level. */
  protected async * predecessors(
    keys: K[], visited: MaybeAsyncMap<K, number>,
    options?: EventStoreQueryOptions<K> & EventStoreQueryOptionsExt<K>,
  ): AsyncGenerator<[key: K, value: V, level: number]> {
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
        if (options?.root === void 0 || equalsOrSameString(options.root, value.meta.root ?? keyBatch[j])) {
          if (!options?.head && value.meta.parents.length) {
            for await (const entry of this.predecessors(value.meta.parents, visited, options)) {
              yield entry;
              level = Math.max(level, entry[2] + 1);
            }
          }
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
