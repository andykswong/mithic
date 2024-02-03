import { AbortOptions, ContentId, MaybePromise, OperationError, StringEquatable } from '@mithic/commons';
import { EventStore, EventStoreQueryOptions, EventStoreMetaQueryOptions } from '../eventstore.ts';
import { BTreeMap, ContentAddressedMapStore } from '../impl/index.ts';
import { MaybeAsyncMap, MaybeAsyncMapBatch, AppendOnlyAutoKeyMap, AutoKeyMapBatch } from '../map.ts';
import { RangeQueryable } from '../range.ts';
import { Batch } from '../utils/index.ts';
import { BaseDagEventStore } from './base/index.ts';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER, atomicHybridTime } from './defaults.ts';
import { EventMeta } from './event.ts';
import { getEventIndexKeys, getEventIndexRangeQueryOptions } from './indices.ts';

/**
 * A simple implementation of indexed {@link EventStore} backed by {@link RangeQueryable} {@link MaybeAsyncMap}s.
 * In addition to topological ordering, it uses an atomic hybrid time to order concurrent events.
 */
export class IndexedEventStore<
  K extends StringEquatable<K> = ContentId,
  V = unknown
> extends BaseDagEventStore<K, V, EventStoreMetaQueryOptions<K>>
  implements EventStore<K, V, EventStoreMetaQueryOptions<K>>, AsyncIterable<[K, V]>
{
  protected readonly index:
    MaybeAsyncMap<string, K> & Partial<MaybeAsyncMapBatch<string, K>> & RangeQueryable<string, K>;
  protected readonly encodeKey: (key: K) => string;
  protected readonly setEventTime: (event: V, time: number) => V;
  protected readonly tick: (refTime?: number) => MaybePromise<number>;
  protected readonly eventTypeSeparator: RegExp;

  public constructor({
    data = new ContentAddressedMapStore<K, V>(),
    index = new BTreeMap<string, K>(5),
    encodeKey = DEFAULT_KEY_ENCODER,
    tick = atomicHybridTime(),
    eventTypeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR,
    getEventMeta,
    setEventTime = (event: V, time: number) => ({
      ...(event as EventMeta<K>),
      time,
    } as V),
  }: IndexedEventStoreOptions<K, V> = {}) {
    super(data, getEventMeta);
    this.index = index;
    this.encodeKey = encodeKey;
    this.setEventTime = setEventTime;
    this.tick = tick;
    this.eventTypeSeparator = eventTypeSeparator;
  }

  protected override async prePut(value: V, options?: AbortOptions): Promise<V> {
    const key = await this.getKey(value);
    const parents = this.currentEventDeps;

    let meta = this.getEventMeta(value);
    if (!meta) {
      throw new TypeError('invalid event');
    }

    // assign timestamp
    let newValue = value;
    let latestTime = 0;
    for (const [, parent] of parents) {
      const parentEventMeta = this.getEventMeta(parent);
      latestTime = Math.max(latestTime, parentEventMeta?.time || 0);
    }
    if ((meta.time || 0) < latestTime) {
      const time = await this.tick(latestTime);
      newValue = this.setEventTime(value, time);
      meta = { ...meta, time };
    }

    // update indices
    const entries = getEventIndexKeys(key, meta, false, this.encodeKey, this.eventTypeSeparator)
      .map(indexKey => [indexKey, key] as [string, K?]);

    if (parents.length) { // remove parents from head indices
      entries.push(...parents
        .flatMap(([key, value]) => {
          const event = this.getEventMeta(value);
          return event ? getEventIndexKeys(key, event, true, this.encodeKey, this.eventTypeSeparator) : [];
        })
        .map(index => [index, void 0] as [string, K?])
      );
    }

    for await (const error of Batch.updateMapMany(this.index, entries, options)) {
      if (error) {
        throw new OperationError('failed to save indices', { cause: error });
      }
    }

    return newValue;
  }

  public override async * keys(
    options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>
  ): AsyncGenerator<K, K[]> {
    let sinceTime = 0;
    if (options?.since) {
      for await (const value of this.getMany(options.since, options)) {
        const eventMeta = value && this.getEventMeta(value);
        sinceTime = Math.max(sinceTime, eventMeta?.time || 0);
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
  readonly data?: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>;

  /** Backing index store map. */
  readonly index?: MaybeAsyncMap<string, K> & Partial<MaybeAsyncMapBatch<string, K>> & RangeQueryable<string, K>;

  /** Encoder of event key to bytes. */
  readonly encodeKey?: (key: K) => string;

  /** Function to atomically return a logical timestamp used as auto-incremented index of next event. */
  readonly tick?: (refTime?: number) => MaybePromise<number>;

  /** Regex to split scoped event type. */
  readonly eventTypeSeparator?: RegExp;

  /** Function to get given event metadata. */
  readonly getEventMeta?: (event: V) => EventMeta<K> | undefined,

  /** Function to set event time and return updated event. */
  readonly setEventTime?: (event: V, time: number) => V,
}
