import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BTreeMap, ContentAddressedMapStore, MaybeAsyncMap, MaybeAsyncMapBatch,
  RangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, ErrorCode, MaybePromise, StringEquatable, operationError } from '@mithic/commons';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER } from '../../defaults.js';
import { Event, EventMetadata } from '../../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreMetaQueryOptions } from '../../store.js';
import { atomicHybridTime } from '../../time.js';
import { BaseDagEventStore } from '../base.js';
import { getEventIndexKeys, getEventIndexRangeQueryOptions } from './indices.js';

/**
 * A simple implementation of indexed {@link EventStore} backed by {@link RangeQueryable} {@link MaybeAsyncMap}s.
 * In addition to topological ordering, it uses an atomic hybrid time to order concurrent events.
 */
export class IndexedEventStore<
  K extends StringEquatable<K> = ContentId,
  V extends Event<unknown, IndexedEventMetadata<K>> = Event<unknown, IndexedEventMetadata<K>>
> extends BaseDagEventStore<K, V, EventStoreMetaQueryOptions<K>>
  implements EventStore<K, V, EventStoreMetaQueryOptions<K>>, AsyncIterable<[K, V]>
{
  protected readonly index:
    MaybeAsyncMap<string, K> & Partial<MaybeAsyncMapBatch<string, K>> & RangeQueryable<string, K>;
  protected readonly encodeKey: (key: K) => string;
  protected readonly tick: (refTime?: number) => MaybePromise<number>;
  protected readonly eventTypeSeparator: RegExp;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    index = new BTreeMap<string, K>(5),
    encodeKey = DEFAULT_KEY_ENCODER,
    tick = atomicHybridTime(),
    eventTypeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
  }: IndexedEventStoreOptions<K, V> = {}) {
    super(data);
    this.index = index;
    this.encodeKey = encodeKey;
    this.tick = tick;
    this.eventTypeSeparator = eventTypeSeparator;
  }

  protected async prePut(event: V, options?: AbortOptions): Promise<void> {
    const key = await this.getKey(event);
    const parents = this.currentEventDeps;
    let latestTime = 0;

    // assign timestamp
    for (const [, parent] of parents) {
      latestTime = Math.max(latestTime, parent.meta.createdAt || 0);
    }
    event.meta.createdAt = await this.tick(latestTime);

    // update indices
    const entries = getEventIndexKeys(key, event, false, this.encodeKey, this.eventTypeSeparator)
      .map(indexKey => [indexKey, key] as [string, K?]);

    if (parents.length) { // remove parents from head indices
      entries.push(...parents
        .flatMap(([key, event]) => getEventIndexKeys(key, event, true, this.encodeKey, this.eventTypeSeparator))
        .map(index => [index, void 0] as [string, K?])
      );
    }

    if (this.index.updateMany) {
      for await (const error of this.index.updateMany(entries, options)) {
        if (error) {
          throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error);
        }
      }
    } else {
      for (const [key, value] of entries) {
        if (value === void 0) {
          await this.index.delete(key, options);
        } else {
          await this.index.set(key, value, options);
        }
      }
    }

    parents.length = 0;
  }

  public async * keys(options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>): AsyncGenerator<K, K[]> {
    let sinceTime = 0;
    if (options?.since) {
      for await (const value of this.getMany(options.since, options)) {
        if (value) {
          sinceTime = Math.max(sinceTime, value.meta.createdAt || 0);
        }
      }
    }

    let checkpoint: K | undefined;
    const range = getEventIndexRangeQueryOptions(
      sinceTime, options?.type, options?.root, options?.head, this.encodeKey
    );
    for await (const key of this.index.values({ ...range, limit: options?.limit, signal: options?.signal })) {
      yield (checkpoint = key);
    }

    return checkpoint ? [checkpoint] : [];
  }
}

/** Options for creating a {@link IndexedEventStore}. */
export interface IndexedEventStoreOptions<K, V> {
  /** Backing data store map. */
  data?: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>;

  /** Backing index store map. */
  index?: MaybeAsyncMap<string, K> & Partial<MaybeAsyncMapBatch<string, K>> & RangeQueryable<string, K>;

  /** Encoder of event key to bytes. */
  encodeKey?: (key: K) => string;

  /** Function to atomically return a logical timestamp used as auto-incremented index of next event. */
  tick?: (refTime?: number) => MaybePromise<number>;

  /** Regex to split scoped event type. */
  eventTypeSeparator?: RegExp;
}

/** Base {@link EventMetadata} for {@link IndexedEventStore}. */
export interface IndexedEventMetadata<K = ContentId> extends EventMetadata<K> {
  /** (Logical) timestamp at which the event is created/persisted. */
  createdAt?: number;
}
