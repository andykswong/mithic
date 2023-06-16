import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, StringEquatable, equalsOrSameString, operationError,
} from '@mithic/commons';
import { BTreeMap, MaybeAsyncMapBatch, RangeQueryable } from '@mithic/collections';
import { AggregateApplyOptions, AggregateEvent, AggregateRoot } from '../aggregate.js';
import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from './keys.js';
import { defaultEventRef, defaultVoidRef } from './defaults.js';

/** Observed-remove map of values and references. */
export class ORMap<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null | Ref
> implements AggregateRoot<ORMapCommand<Ref, V>, AsyncIterable<[string, V]>, ORMapEvent<Ref, V>, ORMapQuery<Ref>>
{
  protected readonly eventRef: (event: ORMapEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;
  protected readonly isRef: (value: unknown) => value is Ref;
  protected readonly voidRef: () => Ref;
  protected readonly store: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;

  public readonly event = ORMapEventType;

  public constructor({
    eventRef = defaultEventRef,
    isRef = (value): value is Ref => value !== null && !['boolean', 'number', 'string'].includes(typeof value),
    voidRef = defaultVoidRef,
    store = new BTreeMap<string, V>(5),
  }: ORMapOptions<Ref, V>) {
    this.eventRef = eventRef;
    this.isRef = isRef;
    this.voidRef = voidRef;
    this.store = store;
  }

  public async command(command: ORMapCommand<Ref, V> = {}, options?: AbortOptions): Promise<ORMapEvent<Ref, V>> {
    const rootRef = command.ref;
    const rootRefStr = `${rootRef}`;
    const type = rootRef === void 0 ? this.event.New : this.event.Update;
    const ops: [string, Ref | V, ...number[]][] = [];

    const voidRef = this.voidRef();
    const entries = command.entries || {};
    const fields = Object.keys(entries);
    const parents: Ref[] = [];
    const parentsMap: Record<string, number> = {};

    for (const field of fields) {
      const value = entries[field];

      const thisParents: number[] = [];
      if (type === this.event.Update) { // find parents if this is an update event
        for await (const parentRef of this.store.values({
          gt: getHeadIndexKey(rootRefStr, field),
          lt: getPrefixEndKey(getHeadIndexKey(rootRefStr, field)),
          signal: options?.signal,
        })) {
          if (this.isRef(parentRef)) {
            const parentRefStr = `${parentRef}`;
            thisParents.push(parentsMap[parentRefStr] ?? (parents.push(parentRef) - 1));
            parentsMap[parentRefStr] = thisParents[thisParents.length - 1];
          }
        }
      }

      if (this.isRef(value) && equalsOrSameString(value, voidRef) && !thisParents.length) {
        continue; // nothing to delete
      }

      ops.push([field, value, ...thisParents]);
    }

    if (type === this.event.Update && !fields.length) {
      throw operationError('Empty operation', ErrorCode.InvalidArg);
    }

    return {
      type,
      payload: { ops, nounce: type === this.event.New ? command.nounce : void 0 },
      meta: { parents, root: rootRef, createdAt: command.createdAt }
    };
  }

  public async apply(event: ORMapEvent<Ref, V>, options?: AggregateApplyOptions): Promise<void> {
    if (options?.validate ?? true) {
      const error = await this.validate(event, options);
      if (error) { throw error; }
    }

    const voidRef = this.voidRef();
    const eventKey = await this.eventRef(event, options);
    const eventKeyStr = `${eventKey}`;
    const root = event.type === this.event.Update ? event.meta.root as Ref : eventKey;
    const rootRefStr = `${root}`;

    // return early if event is already applied
    for await (const value of this.store.getMany([getEventIndexKey(eventKeyStr)], options)) {
      if (value !== void 0) { return; }
    }

    // save event key with its timestamp
    const entries: [string, (Ref | V | number)?][] = [
      [getEventIndexKey(eventKeyStr), event.meta.createdAt || 0],
    ];

    // update field values
    for (const [field, value, ...parents] of event.payload.ops) {
      if (!(this.isRef(value) && equalsOrSameString(voidRef, value))) { // upsert
        entries.push(
          [getHeadIndexKey(rootRefStr, field, eventKeyStr), eventKey],
          [getFieldValueKey(rootRefStr, field, eventKeyStr), value],
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
  }

  public async validate(event: ORMapEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    if (event.type === this.event.Update) {
      if (!event.payload.ops.length) {
        return operationError('Empty operation', ErrorCode.InvalidArg);
      }
      if (event.meta.root === void 0) {
        return operationError('Missing root', ErrorCode.InvalidArg);
      }
    }

    // verify that set operations are well formed
    const voidRef = this.voidRef();
    for (const [field, value, ...parents] of event.payload.ops) {
      let isValid = !!field && (!!parents.length || !(this.isRef(value) && equalsOrSameString(voidRef, value)));
      for (const parent of parents) {
        if (event.meta.parents[parent] === void 0) {
          isValid = false;
          break;
        }
      }
      if (!isValid) {
        return operationError(`Invalid field operation: "${field}"`, ErrorCode.InvalidArg);
      }
    }

    // verify that event parents are already processed
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

  public async * query(options?: ORMapQuery<Ref>): AsyncIterable<[string, V]> {
    if (options) {
      if (options?.lww) {
        yield* this.queryLWW(options);
      } else {
        yield* this.queryMV(options);
      }
    }
  }

  /** Query map entries and return all concurrent field values. */
  protected async * queryMV(options: ORMapQuery<Ref>): AsyncIterable<[string, V]> {
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
  protected async * queryLWW(options: ORMapQuery<Ref>): AsyncIterable<[string, V]> {
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

/** Event type for {@link ORMap}. */
export enum ORMapEventType {
  /** Creates a new map. */
  New = 'MAP_NEW',

  /** Sets or deletes map fields. */
  Update = 'MAP_SET',
}

/** Query options for {@link ORMap}.  */
export interface ORMapQuery<Ref> extends AbortOptions {
  /** Reference to (root event of) the map. */
  readonly ref: Ref;

  /** Whether to resolve concurrent values by last-write-wins using createdAt time. Defaults to `false`. */
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

/** Command for {@link ORMap}. */
export interface ORMapCommand<Ref, V> {
  /** Reference to (root event of) the map. Creates a new map if not given. */
  readonly ref?: Ref;

  /** Sets given field-value pairs to the map. */
  readonly entries?: Readonly<Record<string, Ref | V>>;

  /** Timestamp of this command. */
  readonly createdAt?: number;

  /** A random number to make a unique event when creating a new map. */
  readonly nounce?: number;
}

/** Event for {@link ORMap}. */
export type ORMapEvent<Ref, V> = AggregateEvent<ORMapEventType, Ref, ORMapEventPayload<Ref, V>>;

/** Event payload for {@link ORMap}. */
export interface ORMapEventPayload<Ref, V> {
  /** Operations to set given field pairs to the map with references to parent event indices. */
  readonly ops: readonly [field: string, value: Ref | V, ...parentIndices: number[]][];

  /** A random number to make a unique event when creating a new map. Undefined for `Set` events. */
  readonly nounce?: number;
}

/** Options for creating an {@link ORMap}. */
export interface ORMapOptions<Ref, V> {
  /** Gets the reference to event from given event. */
  readonly eventRef?: (event: ORMapEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;

  /** Returns if value is a reference type. */
  readonly isRef?: (value: unknown) => value is Ref;

  /** Creates a void reference. */
  readonly voidRef?: () => Ref;

  /** Backing data store. */
  readonly store?: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;
}
