import {
  AbortOptions, ContentId, MaybePromise, OperationError, StringEquatable, SyncOrAsyncIterable,
} from '@mithic/commons';
import { BTreeMap, MaybeAsyncMapBatch, RangeQueryable } from '@mithic/collections';
import { Aggregate, AggregateQuery } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../event.js';
import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from './keys.js';
import { defaultEventKey } from './defaults.js';

/** Abstract map aggregate type. */
export type MapAggregate<K, V> = Aggregate<MapCommand<K, V>, MapEvent<K, V>, MapQuery<K, V>, K>;

/** Observed-remove multivalued map. */
export class ORMap<
  K extends StringEquatable<K> = ContentId,
  V = string | number | boolean | null | K
> implements MapAggregate<K, V> {
  protected readonly eventRef: (event: MapEvent<K, V>, options?: AbortOptions) => MaybePromise<K>;
  protected readonly store: MaybeAsyncMapBatch<string, K | V | number> & RangeQueryable<string, K | V | number>;
  protected readonly trackEventTime: boolean;

  public constructor({
    eventKey: eventRef = defaultEventKey,
    store = new BTreeMap<string, V>(5),
    trackEventTime = false,
  }: ORMapOptions<K, V> = {}) {
    this.eventRef = eventRef;
    this.store = store;
    this.trackEventTime = trackEventTime;
  }

  public async command(command: MapCommand<K, V>, options?: AbortOptions): Promise<MapEvent<K, V>> {
    const rootRef = command.root;
    const rootRefStr = `${rootRef}`;
    const type = rootRef === void 0 ? MapEventType.New : MapEventType.Update;
    const ops: [string, V | null, boolean, ...number[]][] = [];

    const entries = command.payload.set || {};
    const fields = [...(command.payload.del || []), ...Object.keys(entries)];
    const parents: K[] = [];
    const parentsMap: Record<string, number> = {};

    let i = 0;
    for (const field of fields) {
      const value = entries[field] ?? null;

      const thisParents: number[] = [];
      if (type === MapEventType.Update) { // find parents if this is an update event
        for await (const parentRef of this.store.values({
          gt: getHeadIndexKey(rootRefStr, field),
          lt: getPrefixEndKey(getHeadIndexKey(rootRefStr, field)),
          signal: options?.signal,
        })) {
          const parentRefStr = `${parentRef}`;
          thisParents.push(parentsMap[parentRefStr] ?? (parents.push(parentRef as K) - 1));
          parentsMap[parentRefStr] = thisParents[thisParents.length - 1];
        }
      }

      const isDelete = i++ < (command.payload.del?.length || 0);
      if (isDelete && !thisParents.length) {
        continue; // nothing to delete
      }

      ops.push([field, value, isDelete, ...thisParents]);
    }

    if (type === MapEventType.Update && !fields.length) {
      throw new TypeError('empty operation');
    }

    return {
      type,
      payload: { ops },
      link: parents,
      root: rootRef,
      nonce: command?.nonce,
      time: command?.time
    };
  }

  public async reduce(event: MapEvent<K, V>, options?: AbortOptions): Promise<K> {
    const error = await this.validate(event, options);
    if (error) { throw error; }

    const eventRef = await this.eventRef(event, options);
    const eventRefStr = `${eventRef}`;
    const root = event.type === MapEventType.Update ? event.root as K : eventRef;
    const rootRefStr = `${root}`;

    // return early if event found in store
    for await (const value of this.store.getMany([getEventIndexKey(eventRefStr)], options)) {
      if (value !== void 0) { return eventRef; }
    }

    // save event timestamp if enabled
    const entries: [string, (K | V | number)?][] = this.trackEventTime ? [
      [getEventIndexKey(eventRefStr), event.time || 0],
    ] : [];

    // update field values
    for (const [field, value, isDelete, ...parents] of event.payload.ops) {
      if (!isDelete) { // upsert
        entries.push(
          [getHeadIndexKey(rootRefStr, field, eventRefStr), eventRef],
          [getFieldValueKey(rootRefStr, field, eventRefStr), value as V],
        );
      }
      for (const parentIndex of parents) {
        const parentRef = `${event?.link?.[parentIndex]}`;
        entries.push(
          [getHeadIndexKey(rootRefStr, field, parentRef), void 0],
          [getFieldValueKey(rootRefStr, field, parentRef), void 0]
        );
      }
    }

    for await (const error of this.store.updateMany(entries, options)) {
      if (error) { throw new OperationError('failed to save indices', { cause: error }); }
    }

    return eventRef;
  }

  public async validate(event: MapEvent<K, V>, options?: AbortOptions): Promise<Error | undefined> {
    if (event.type === MapEventType.Update) {
      if (!event.payload.ops.length) {
        return new TypeError('empty operation');
      }
      if (event?.root === void 0) {
        return new TypeError('missing root');
      }
    }

    // verify that set operations are well formed
    for (const [field, _, isDelete, ...parents] of event.payload.ops) {
      let isValid = !!field && (!!parents.length || !isDelete);
      for (const parent of parents) {
        if (event.link?.[parent] === void 0) {
          isValid = false;
          break;
        }
      }
      if (!isValid) {
        return new TypeError(`invalid operation: "${field}"`);
      }
    }

    // verify that event parents have been processed
    // this is possible only if we are tracking the event keys along with their timestamps
    if (this.trackEventTime) {
      const parentKeys = event.link?.map((parent) => getEventIndexKey(`${parent}`)) || [];
      if (event.root !== void 0) {
        parentKeys.push(getEventIndexKey(`${event.root}`));
      }
      const missing = [];
      let i = 0;
      for await (const value of this.store.getMany(parentKeys, options)) {
        if (value === void 0) {
          missing.push(event.link?.[i] ?? event.root);
        }
        ++i;
      }
      if (missing.length) {
        return new OperationError('missing dependencies', { detail: missing });
      }
    }
  }

  public async * query(query: MapQuery<K, V>, options?: AbortOptions): AsyncIterable<[field: string, value: V]> {
    if (query.lww) {
      yield* this.queryLWW(query, options);
    } else {
      yield* this.queryMV(query, options);
    }
  }

  /** Query map entries and return all concurrent field values. */
  protected async * queryMV(query: MapQuery<K, V>, options?: AbortOptions): AsyncIterable<[string, V]> {
    const map = `${query.root}`;
    const limit = query.limit ?? Infinity;
    let currentField: string | undefined;
    let fieldCount = 0;

    for await (const [key, value] of this.store.entries({
      gt: getFieldValueKey(map, query.gte),
      lt: getPrefixEndKey(getFieldValueKey(map, query.lte)),
      reverse: query.reverse,
      signal: options?.signal,
    })) {
      const field = getFieldNameFromKey(key);
      if (field) {
        if (currentField !== field) {
          currentField = field;
          if (++fieldCount > limit) {
            break;
          }
        }
        yield [field, value as V];
      }
    }
  }

  /** Queries entries by last-write-wins. */
  protected async * queryLWW(query: MapQuery<K, V>, options?: AbortOptions): AsyncIterable<[string, V]> {
    const map = `${query.root}`;
    const limit = query.limit ?? Infinity;

    // Get concurrent event refs for each field
    const fields: [name: string, eventRefs: string[]][] = [];
    let currentField: string | undefined;
    for await (const [key, value] of this.store.entries({
      gt: getHeadIndexKey(map, query.gte),
      lt: getPrefixEndKey(getHeadIndexKey(map, query.lte)),
      reverse: query.reverse,
      signal: options?.signal,
    })) {
      const field = getFieldNameFromKey(key);
      if (field) {
        if (currentField !== field) {
          if (fields.length + 1 > limit) {
            break;
          }
          currentField = field;
          fields.push([currentField, []]);
        }
        fields[fields.length - 1][1].push(`${value}`);
      }
    }

    // resolve timestamps for each event ref
    const eventRefs: Record<string, number> = {};
    const eventTimestamps = [];
    {
      let i = 0;
      for (const [_, refs] of fields) {
        for (const ref of refs) {
          eventRefs[ref] = 0;
        }
      }
      const eventKeys = Object.keys(eventRefs).map((ref) => {
        eventRefs[ref] = i++;
        return getEventIndexKey(ref);
      });
      for await (const value of this.store.getMany(eventKeys, options)) {
        eventTimestamps.push(+(value || 0) || 0);
      }
    }

    // find the LWW event reference for each field
    const lwwKeys: string[] = [];
    for (const [field, refs] of fields) {
      let lastTime = -1;
      let lwwRef = '';
      for (const ref of refs) {
        const time = eventTimestamps[eventRefs[ref]];
        if (time > lastTime || (time === lastTime && ref > lwwRef)) {
          lastTime = time;
          lwwRef = ref;
        }
      }
      lwwRef && lwwKeys.push(getFieldValueKey(map, field, lwwRef));
    }

    // query the values for each LWW event reference
    let i = 0;
    for await (const value of this.store.getMany(lwwKeys, options)) {
      if (value !== void 0) {
        yield [getFieldNameFromKey(lwwKeys[i]), value as V];
      }
      ++i;
    }
  }
}

/** Command type for {@link MapAggregate}. */
export enum MapCommandType {
  /** Sets or deletes map fields. */
  Update = 'MAP_OPS',
}

/** Event type for {@link MapAggregate}. */
export enum MapEventType {
  /** Creates a new map. */
  New = 'MAP_NEW',

  /** Sets or deletes map fields. */
  Update = 'MAP_OPS',
}

/** Query options for {@link MapAggregate}.  */
export interface MapQuery<Ref, V> extends AggregateQuery<SyncOrAsyncIterable<[string, V]>> {
  /** Reference to (root event of) the map. */
  readonly root: Ref;

  /**
   * Whether to resolve concurrent values by last-write-wins by comparing createdAt time followed by event refs.
   * Supported only when map has `trackEventTime` enabled. Defaults to `false`.
   */
  readonly lww?: boolean;

  /** Returns only entries with field names greater than or equal to given name. */
  readonly gte?: string;

  /** Returns only entries with field names less than or equal to given name. */
  readonly lte?: string;

  /** Returns entries in reverse order. */
  readonly reverse?: boolean;

  /** Maximum number of results to return. Defaults to `Infinity`. */
  readonly limit?: number;
}

/** Command for {@link MapAggregate}. */
export type MapCommand<K, V> = StandardCommand<MapCommandType, MapCommandPayload<V>, K>;

/** Command payload for {@link MapAggregate}. */
export interface MapCommandPayload<V> {
  /** Sets given field-value pairs to the map. */
  readonly set?: Readonly<Record<string, V>>;

  /** Deletes given fields from the map. */
  readonly del?: readonly string[];
}

/** Event for {@link MapAggregate}. */
export type MapEvent<K, V> = StandardEvent<MapEventType, MapEventPayload<V>, K>;

/** Event payload for {@link MapAggregate}. */
export interface MapEventPayload<V> {
  /** Operations to set given field pairs to the map with references to parent event indices. */
  readonly ops: readonly [field: string, value: V | null, isDelete: boolean, ...parentIndices: number[]][];
}

/** Options for creating an {@link ORMap}. */
export interface ORMapOptions<K, V> {
  /** Gets the key from given event. */
  readonly eventKey?: (event: MapEvent<K, V>, options?: AbortOptions) => MaybePromise<K>;

  /** Backing data store. */
  readonly store?: MaybeAsyncMapBatch<string, K | V | number> & RangeQueryable<string, K | V | number>;

  /** Whether to track event createdAt time, which is required for LWW queries. Defaults to `false`. */
  readonly trackEventTime?: boolean;
}
