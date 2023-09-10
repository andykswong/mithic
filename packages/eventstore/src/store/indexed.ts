import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BTreeMap, Batch, ContentAddressedMapStore, MaybeAsyncMap, MaybeAsyncMapBatch,
  RangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, ErrorCode, MaybePromise, StringEquatable, operationError } from '@mithic/commons';
import { StandardEvent } from '@mithic/cqrs/event';
import { BaseDagEventStore } from '../base/index.js';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER, atomicHybridTime } from '../defaults.js';
import { EventStore, EventStoreQueryOptions, EventStoreMetaQueryOptions } from '../store.js';
import { getEventIndexKeys, getEventIndexRangeQueryOptions } from './indices.js';

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
    toStandardEvent,
    setEventTime = (event: V, time: number) => ({
      ...(event as StandardEvent),
      meta: { ...(event as StandardEvent).meta, time },
    } as V),
  }: IndexedEventStoreOptions<K, V> = {}) {
    super(data, toStandardEvent);
    this.index = index;
    this.encodeKey = encodeKey;
    this.setEventTime = setEventTime;
    this.tick = tick;
    this.eventTypeSeparator = eventTypeSeparator;
  }

  protected override async prePut(value: V, options?: AbortOptions): Promise<V> {
    const key = await this.getKey(value);
    const parents = this.currentEventDeps;
    let latestTime = 0;

    // assign timestamp
    for (const [, parent] of parents) {
      const parentEvent = this.toStandardEvent(parent);
      latestTime = Math.max(latestTime, parentEvent?.meta?.time || 0);
    }
    const newValue = this.setEventTime(value, await this.tick(latestTime));

    const event = this.toStandardEvent(newValue);
    if (!event) {
      throw operationError('Invalid event', ErrorCode.InvalidArg);
    }

    // update indices
    const entries = getEventIndexKeys(key, event, false, this.encodeKey, this.eventTypeSeparator)
      .map(indexKey => [indexKey, key] as [string, K?]);

    if (parents.length) { // remove parents from head indices
      entries.push(...parents
        .flatMap(([key, value]) => {
          const event = this.toStandardEvent(value);
          return event ? getEventIndexKeys(key, event, true, this.encodeKey, this.eventTypeSeparator) : [];
        })
        .map(index => [index, void 0] as [string, K?])
      );
    }

    for await (const error of Batch.updateMapMany(this.index, entries, options)) {
      if (error) {
        throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error);
      }
    }

    return newValue;
  }

  public override async * keys(options?: EventStoreQueryOptions<K> & EventStoreMetaQueryOptions<K>): AsyncGenerator<K, K[]> {
    let sinceTime = 0;
    if (options?.since) {
      for await (const value of this.getMany(options.since, options)) {
        const event = value && this.toStandardEvent(value);
        sinceTime = Math.max(sinceTime, event?.meta?.time || 0);
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

  /** Function to get given event as {@link StandardEvent} format. */
  toStandardEvent?: (event: V) => StandardEvent<string, unknown, K> | undefined,

  /** Function to set event time and return updated event. */
  setEventTime?: (event: V, time: number) => V,
}
