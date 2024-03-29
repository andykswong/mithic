import {
  AbortOptions, Codec, ContentId, OperationError, StringEquatable, SyncOrAsyncIterable, equalsOrSameString
} from '@mithic/commons';
import { EventStore, EventStoreQueryOptions, EventStoreMetaQueryOptions } from '../eventstore.ts';
import { MaybeAsyncMap, AppendOnlyAutoKeyMap, AutoKeyMapBatch } from '../map.ts';
import { ContentAddressedMapStore, TransformedSet, TransformedMap, BinaryHeap } from '../impl/index.ts';
import { MaybeAsyncReadonlySet, MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.ts';
import { Batch } from '../utils/index.ts';
import { BaseDagEventStore } from './base/index.ts';
import { DEFAULT_BATCH_SIZE, decodeCID } from './defaults.ts';
import { EventMeta } from './event.ts';

/** An {@link EventStore} implementation that stores a direct-acyclic graph of content-addressable events. */
export class DagEventStore<
  K extends StringEquatable<K> = ContentId,
  V = unknown
> extends BaseDagEventStore<K, V, EventStoreMetaQueryOptions<K>>
  implements EventStore<K, V, EventStoreMetaQueryOptions<K>>, AsyncIterable<[K, V]>
{
  protected readonly keyCodec: Codec<K, string>;
  protected readonly headSet: MaybeAsyncSet<K> & Partial<MaybeAsyncSetBatch<K>> & SyncOrAsyncIterable<K>;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    keyCodec = { encode: (key) => `${key}`, decode: decodeCID },
    head = new TransformedSet<K, string, Set<string>>(new Set(), keyCodec),
    getEventMeta,
  }: DagEventStoreOptions<K, V> = {}) {
    super(data, getEventMeta);
    this.keyCodec = keyCodec;
    this.headSet = head;
  }

  /** The head event keys. */
  public get heads(): MaybeAsyncReadonlySet<K> & SyncOrAsyncIterable<K> {
    return this.headSet;
  }

  /** Queries entries by given criteria. */
  public override async * entries(
    options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>
  ): AsyncGenerator<[K, V], K[]> {
    const headOnly = options?.head || false;
    const limit = options?.limit ?? Infinity;

    // TODO: any way to optimize this?
    // build map of visited keys to their levels
    const visited = new TransformedMap<K, number, string, number, Map<string, number>>(new Map(), this.keyCodec);
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
        this.keyCodec.encode(entries[i][0]).localeCompare(this.keyCodec.encode(entries[j][0])),
      true
    );
    const heads = new TransformedMap<K, V, string, V, Map<string, V>>(new Map(), this.keyCodec);
    for (let count = 0, i = queue.shift(); i !== void 0 && count < limit; i = queue.shift()) {
      const [key, value] = entries[i];

      // yield matching entires. skip if head = true, as we will do this later
      if (!headOnly) {
        yield [key, value];
        ++count;
      }

      // update head set
      heads.set(key, value);
      const links = this.getEventMeta(value)?.link;
      if (links?.length) {
        for await (const error of heads.deleteMany(links, options)) {
          if (error) {
            throw new OperationError('failed to update head', { cause: error });
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

  protected override async prePut(value: V, options?: AbortOptions): Promise<V> {
    const key = await this.getKey(value);
    const event = this.getEventMeta(value);

    // update head
    const changeSet: [K, boolean][] = [
      [key, true],
      ...(event?.link?.map((key) => [key, false] as [K, boolean]) || [])
    ];
    for await (const error of Batch.updateSetMany(this.headSet, changeSet, options)) {
      if (error) {
        throw new OperationError('failed to update head', { cause: error });
      }
    }

    return value;
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
        const meta = this.getEventMeta(value);
        if (meta === void 0) {
          continue;
        }

        let level = await visited.get(keyBatch[j], options);
        const keyVisited = level !== void 0;
        level = level || 0;
        if (keyVisited) {
          continue;
        }

        if (!options?.head && meta?.link?.length) {
          for await (const entry of this.predecessors(meta.link, visited, options)) {
            yield entry;
            level = Math.max(level, entry[2] + 1);
          }
        }

        if (
          (options?.root === void 0 || equalsOrSameString(options.root, meta?.root ?? keyBatch[j])) &&
          meta.type.startsWith(options?.type || '')
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
  readonly data?: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>;

  /** Head event set. */
  readonly head?: MaybeAsyncSet<K> & Partial<MaybeAsyncSetBatch<K>> & SyncOrAsyncIterable<K>;

  /** Event key to string codec. */
  readonly keyCodec?: Codec<K, string>;

  /** Function to get given event metadata. */
  readonly getEventMeta?: (event: V) => EventMeta<K> | undefined,
}

function* range(length: number): IterableIterator<number> {
  for (let i = 0; i < length; ++i) {
    yield i;
  }
}
