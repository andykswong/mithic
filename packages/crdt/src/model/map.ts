import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, StringEquatable, SyncOrAsyncIterable, operationError,
} from '@mithic/commons';
import { BTreeMap, MaybeAsyncMapBatch, RangeQueryable } from '@mithic/collections';
import { AggregateApplyOptions, AggregateCommandMeta, AggregateEvent, Aggregate } from '../aggregate.js';
import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from './keys.js';
import { defaultEventRef } from './defaults.js';

/** Abstract map aggregate type. */
export type MapAggregate<Ref, V> =
  Aggregate<MapCommand<Ref, V>, Ref, MapEvent<Ref, V>, SyncOrAsyncIterable<[string, V]>, MapQuery<Ref>>;

/** Observed-remove multivalued map. */
export class ORMap<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null | Ref
> implements MapAggregate<Ref, V> {
  protected readonly eventRef: (event: MapEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;
  protected readonly store: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;
  protected readonly trackEventTime: boolean;

  public readonly event = MapEventType;

  public constructor({
    eventRef = defaultEventRef,
    store = new BTreeMap<string, V>(5),
    trackEventTime = false,
  }: ORMapOptions<Ref, V> = {}) {
    this.eventRef = eventRef;
    this.store = store;
    this.trackEventTime = trackEventTime;
  }

  public async command(command: MapCommand<Ref, V> = {}, options?: AbortOptions): Promise<MapEvent<Ref, V>> {
    const rootRef = command.ref;
    const rootRefStr = `${rootRef}`;
    const type = rootRef === void 0 ? this.event.New : this.event.Update;
    const ops: [string, V | null, boolean, ...number[]][] = [];

    const entries = command.set || {};
    const fields = [...(command.del || []), ...Object.keys(entries)];
    const parents: Ref[] = [];
    const parentsMap: Record<string, number> = {};

    let i = 0;
    for (const field of fields) {
      const value = entries[field] ?? null;

      const thisParents: number[] = [];
      if (type === this.event.Update) { // find parents if this is an update event
        for await (const parentRef of this.store.values({
          gt: getHeadIndexKey(rootRefStr, field),
          lt: getPrefixEndKey(getHeadIndexKey(rootRefStr, field)),
          signal: options?.signal,
        })) {
          const parentRefStr = `${parentRef}`;
          thisParents.push(parentsMap[parentRefStr] ?? (parents.push(parentRef as Ref) - 1));
          parentsMap[parentRefStr] = thisParents[thisParents.length - 1];
        }
      }

      const isDelete = i++ < (command.del?.length || 0);
      if (isDelete && !thisParents.length) {
        continue; // nothing to delete
      }

      ops.push([field, value, isDelete, ...thisParents]);
    }

    if (type === this.event.Update && !fields.length) {
      throw operationError('Empty operation', ErrorCode.InvalidArg);
    }

    return {
      type,
      payload: { ops, nonce: type === this.event.New ? command.nonce : void 0 },
      meta: { parents, root: rootRef, createdAt: command.createdAt }
    };
  }

  public async apply(event: MapEvent<Ref, V>, options?: AggregateApplyOptions): Promise<Ref> {
    if (options?.validate ?? true) {
      const error = await this.validate(event, options);
      if (error) { throw error; }
    }

    const eventRef = await this.eventRef(event, options);
    const eventRefStr = `${eventRef}`;
    const root = event.type === this.event.Update ? event.meta.root as Ref : eventRef;
    const rootRefStr = `${root}`;

    // return early if event found in store
    for await (const value of this.store.getMany([getEventIndexKey(eventRefStr)], options)) {
      if (value !== void 0) { return eventRef; }
    }

    // save event timestamp if enabled
    const entries: [string, (Ref | V | number)?][] = this.trackEventTime ? [
      [getEventIndexKey(eventRefStr), event.meta.createdAt || 0],
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
        const parentRef = `${event.meta.parents[parentIndex]}`;
        entries.push(
          [getHeadIndexKey(rootRefStr, field, parentRef), void 0],
          [getFieldValueKey(rootRefStr, field, parentRef), void 0]
        );
      }
    }

    for await (const error of this.store.updateMany(entries, options)) {
      if (error) { throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error); }
    }

    return eventRef;
  }

  public async validate(event: MapEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    if (event.type === this.event.Update) {
      if (!event.payload.ops.length) {
        return operationError('Empty operation', ErrorCode.InvalidArg);
      }
      if (event.meta.root === void 0) {
        return operationError('Missing root', ErrorCode.InvalidArg);
      }
    }

    // verify that set operations are well formed
    for (const [field, _, isDelete, ...parents] of event.payload.ops) {
      let isValid = !!field && (!!parents.length || !isDelete);
      for (const parent of parents) {
        if (event.meta.parents[parent] === void 0) {
          isValid = false;
          break;
        }
      }
      if (!isValid) {
        return operationError(`Invalid operation: "${field}"`, ErrorCode.InvalidArg);
      }
    }

    // verify that event parents have been processed
    // this is possible only if we are tracking the event keys along with their timestamps
    if (this.trackEventTime) {
      const parentKeys = event.meta.parents.map((parent) => getEventIndexKey(`${parent}`));
      if (event.meta.root !== void 0) {
        parentKeys.push(getEventIndexKey(`${event.meta.root}`));
      }
      const missing = [];
      let i = 0;
      for await (const value of this.store.getMany(parentKeys, options)) {
        if (value === void 0) {
          missing.push(event.meta.parents[i]);
        }
        ++i;
      }
      if (missing.length) {
        return operationError('Missing dependencies', ErrorCode.MissingDep, missing);
      }
    }
  }

  public async * query(options?: MapQuery<Ref>): AsyncIterable<[field: string, value: V]> {
    if (options) {
      if (options?.lww) {
        yield* this.queryLWW(options);
      } else {
        yield* this.queryMV(options);
      }
    }
  }

  /** Query map entries and return all concurrent field values. */
  protected async * queryMV(options: MapQuery<Ref>): AsyncIterable<[string, V]> {
    const map = `${options.ref}`;
    const limit = options.limit ?? Infinity;
    let currentField: string | undefined;
    let fieldCount = 0;

    for await (const [key, value] of this.store.entries({
      gt: getFieldValueKey(map, options.gte),
      lt: getPrefixEndKey(getFieldValueKey(map, options.lte)),
      reverse: options.reverse,
      signal: options.signal,
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
  protected async * queryLWW(options: MapQuery<Ref>): AsyncIterable<[string, V]> {
    const map = `${options.ref}`;
    const limit = options.limit ?? Infinity;

    // Get concurrent event refs for each field
    const fields: [name: string, eventRefs: string[]][] = [];
    let currentField: string | undefined;
    for await (const [key, value] of this.store.entries({
      gt: getHeadIndexKey(map, options.gte),
      lt: getPrefixEndKey(getHeadIndexKey(map, options.lte)),
      reverse: options.reverse,
      signal: options.signal,
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

/** Event type for {@link MapAggregate}. */
export enum MapEventType {
  /** Creates a new map. */
  New = 'MAP_NEW',

  /** Sets or deletes map fields. */
  Update = 'MAP_OPS',
}

/** Query options for {@link MapAggregate}.  */
export interface MapQuery<Ref> extends AbortOptions {
  /** Reference to (root event of) the map. */
  readonly ref: Ref;

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
export interface MapCommand<Ref, V> extends AggregateCommandMeta<Ref> {
  /** Sets given field-value pairs to the map. */
  readonly set?: Readonly<Record<string, V>>;

  /** Deletes given fields from the map. */
  readonly del?: readonly string[];
}

/** Event for {@link MapAggregate}. */
export type MapEvent<Ref, V> = AggregateEvent<MapEventType, Ref, MapEventPayload<V>>;

/** Event payload for {@link MapAggregate}. */
export interface MapEventPayload<V> {
  /** Operations to set given field pairs to the map with references to parent event indices. */
  readonly ops: readonly [field: string, value: V | null, isDelete: boolean, ...parentIndices: number[]][];

  /** A random number to make a unique event when creating a new map. Undefined for `Set` events. */
  readonly nonce?: number;
}

/** Options for creating an {@link ORMap}. */
export interface ORMapOptions<Ref, V> {
  /** Gets the reference to event from given event. */
  readonly eventRef?: (event: MapEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;

  /** Backing data store. */
  readonly store?: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;

  /** Whether to track event createdAt time, which is required for LWW queries. Defaults to `false`. */
  readonly trackEventTime?: boolean;
}
