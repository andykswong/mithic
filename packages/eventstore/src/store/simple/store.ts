import {
  AppendOnlyAutoKeyMap, AutoKeyMapBatch, BTreeMap, ContentAddressedMapStore, MaybeAsyncMap, MaybeAsyncMapBatch,
  RangeQueryable
} from '@mithic/collections';
import {
  AbortOptions, ContentId, ErrorCode, MaybePromise, StringEquatable, compareBuffers, equalsOrSameString, operationError
} from '@mithic/commons';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER } from '../../defaults.js';
import { Event, EventMetadata } from '../../event.js';
import { EventStore, EventStoreQueryOptions, EventStoreQueryOptionsExt } from '../../store.js';
import { atomicHybridTime } from '../../time.js';
import { BaseMapEventStore } from '../mapstore.js';
import { getEventIndexKeys, getEventIndexRangeQueryOptions } from './indices.js';

/**
 * A simple {@link EventStore} implementation, backed by {@link RangeQueryable} {@link MaybeAsyncMap}s.
 * It uses an atomic hybrid time to order events.
 */
export class SimpleEventStore<
  Id extends StringEquatable<Id> = ContentId,
  E extends Event<unknown, SimpleEventMetadata<Id>> = Event<unknown, SimpleEventMetadata<Id>>
> extends BaseMapEventStore<Id, E, EventStoreQueryOptionsExt<Id>>
  implements EventStore<Id, E, EventStoreQueryOptionsExt<Id>>, AsyncIterable<[Id, E]>
{
  protected readonly index:
    MaybeAsyncMap<Uint8Array, Id> & Partial<MaybeAsyncMapBatch<Uint8Array, Id>> & RangeQueryable<Uint8Array, Id>;
  protected readonly encodeKey: (key: Id) => Uint8Array;
  protected readonly tick: (refTime?: number) => MaybePromise<number>;
  protected readonly eventTypeSeparator: RegExp;

  public constructor({
    data = new ContentAddressedMapStore<Id, E>(),
    index = new BTreeMap<Uint8Array, Id>(5, compareBuffers),
    encodeKey = DEFAULT_KEY_ENCODER,
    tick = atomicHybridTime(),
    eventTypeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
  }: SimpleEventStoreOptions<Id, E> = {}) {
    super(data);
    this.index = index;
    this.encodeKey = encodeKey;
    this.tick = tick;
    this.eventTypeSeparator = eventTypeSeparator;
  }

  /**
   * Puts given event into this store and returns its key.
   * @throws {CodedError<Id[]>} If error.code === ErrorCode.MissingDep,
   *                            error detail contains the list of invalid or missing events.
   */
  public async put(event: E, options?: AbortOptions): Promise<Id> {
    const parents: [Id, E][] = [];
    let latestTime = event.meta.createdAt || 0;
    if (event.meta.parents.length) {
      const rootId = event.meta.root;
      if (!rootId) { // root Id must be specified if there are dependencies
        throw operationError('Missing root Id', ErrorCode.InvalidArg);
      }

      const missing: Id[] = [];
      let hasMatchingParentRoot = false;
      let i = 0;
      for await (const parent of this.getMany(event.meta.parents, options)) {
        const key = event.meta.parents[i++];
        if (!parent) {
          missing.push(key);
          continue;
        }

        parents.push([key, parent]);
        latestTime = Math.max(latestTime, (parent.meta.createdAt || 0) + 1);
        hasMatchingParentRoot = hasMatchingParentRoot || equalsOrSameString(rootId, parent.meta.root ?? key);
      }

      if (missing.length) {
        throw operationError('Missing dependencies', ErrorCode.MissingDep, missing);
      }

      if (!hasMatchingParentRoot) { // root Id must match one of parents' root
        throw operationError('Invalid root Id', ErrorCode.InvalidArg);
      }
    }

    event.meta.createdAt = await this.tick(latestTime); // assign timestamp

    const key = await this.getKey(event);
    if (await this.data.has(key, options)) {
      return key;
    }

    { // update indices
      const entries = getEventIndexKeys(key, event, false, this.encodeKey, this.eventTypeSeparator)
        .map(indexKey => [indexKey, key] as [Uint8Array, Id?]);

      if (parents.length) { // remove parents from head indices
        entries.push(...parents
          .flatMap(([key, event]) => getEventIndexKeys(key, event, true, this.encodeKey, this.eventTypeSeparator))
          .map(index => [index, void 0] as [Uint8Array, Id?])
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
    }

    // save event
    return super.put(event, options);
  }

  public async * keys(options?: EventStoreQueryOptions<Id> & EventStoreQueryOptionsExt<Id>): AsyncGenerator<Id, Id[]> {
    let sinceTime = 0;
    if (options?.since) {
      for await (const value of this.getMany(options.since, options)) {
        if (value) {
          sinceTime = Math.max(sinceTime, value.meta.createdAt || 0);
        }
      }
    }

    let checkpoint: Id | undefined;
    const range = getEventIndexRangeQueryOptions(
      sinceTime, options?.type, options?.root, options?.head, this.encodeKey
    );
    for await (const key of this.index.values({ ...range, limit: options?.limit, signal: options?.signal })) {
      yield (checkpoint = key);
    }

    return checkpoint ? [checkpoint] : [];
  }
}

/** Options for creating a {@link SimpleEventStore}. */
export interface SimpleEventStoreOptions<Id, E> {
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

/** Base {@link EventMetadata} for {@link SimpleEventStore}. */
export interface SimpleEventMetadata<Id = ContentId> extends EventMetadata<Id> {
  /** (Logical) timestamp at which the event is created/persisted. */
  createdAt?: number;
}
