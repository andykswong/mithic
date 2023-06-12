import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BTreeMap, ContentAddressedMapStore, MaybeAsyncMap, MaybeAsyncMapBatch,
  RangeQueryable
} from '@mithic/collections';
import {
  AbortOptions, ContentId, ErrorCode, MaybePromise, StringEquatable, compareBuffers, operationError
} from '@mithic/commons';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER } from '../../defaults.js';
import { Event, EventMetadata } from '../../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreQueryOptionsExt } from '../../store.js';
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
> extends BaseDagEventStore<K, V, EventStoreQueryOptionsExt<K>>
  implements EventStore<K, V, EventStoreQueryOptionsExt<K>>, AsyncIterable<[K, V]>
{
  protected readonly index:
    MaybeAsyncMap<Uint8Array, K> & Partial<MaybeAsyncMapBatch<Uint8Array, K>> & RangeQueryable<Uint8Array, K>;
  protected readonly encodeKey: (key: K) => Uint8Array;
  protected readonly tick: (refTime?: number) => MaybePromise<number>;
  protected readonly eventTypeSeparator: RegExp;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    index = new BTreeMap<Uint8Array, K>(5, compareBuffers),
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
      .map(indexKey => [indexKey, key] as [Uint8Array, K?]);

    if (parents.length) { // remove parents from head indices
      entries.push(...parents
        .flatMap(([key, event]) => getEventIndexKeys(key, event, true, this.encodeKey, this.eventTypeSeparator))
        .map(index => [index, void 0] as [Uint8Array, K?])
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

  public async * keys(options?: EventStoreQueryOptions<K> & EventStoreQueryOptionsExt<K>): AsyncGenerator<K, K[]> {
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
export interface IndexedEventStoreOptions<Id, E> {
  /** Backing data store map. */
  data?: AppendOnlyAutoKeyMap<Id, E> & Partial<AutoKeyMapBatch<Id, E>>;

  /** Backing index store map. */
  index?: MaybeAsyncMap<Uint8Array, Id> & Partial<MaybeAsyncMapBatch<Uint8Array, Id>> & RangeQueryable<Uint8Array, Id>;

  /** Encoder of event key to bytes. */
  encodeKey?: (key: Id) => Uint8Array;

  /** Function to atomically return a logical timestamp used as auto-incremented index of next event. */
  tick?: (refTime?: number) => MaybePromise<number>;

  /** Regex to split scoped event type. */
  eventTypeSeparator?: RegExp;
}

/** Base {@link EventMetadata} for {@link IndexedEventStore}. */
export interface IndexedEventMetadata<Id = ContentId> extends EventMetadata<Id> {
  /** (Logical) timestamp at which the event is created/persisted. */
  createdAt?: number;
}
