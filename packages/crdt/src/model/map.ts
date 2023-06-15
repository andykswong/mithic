import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, StringEquatable, equalsOrSameString, operationError,
  sha256
} from '@mithic/commons';
import { BTreeMap, MaybeAsyncMapBatch, RangeQueryable } from '@mithic/collections';
import { AggregateApplyOptions, AggregateEvent, AggregateRoot } from '../aggregate.js';
import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from './keys.js';

/** Default eventRef implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
const defaultEventRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const dagCbor = await import('@ipld/dag-cbor');
    return <Ref, V>(event: ORMapEvent<Ref, V>) =>
      CID.createV1(dagCbor.code, sha256.digest(dagCbor.encode(event))) as unknown as Ref;
  } catch (_) {
    return () => { throw operationError('multiformats or @ipld/dag-cbor not available', ErrorCode.InvalidState); };
  }
})();

/** Default voidRef implementation that uses multiformats as optional dependency. */
const defaultVoidRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { identity } = await import('multiformats/hashes/identity');
    return <Ref>() => CID.createV1(0x55, identity.digest(new Uint8Array())) as unknown as Ref;
  } catch (_) {
    return () => { throw operationError('multiformats not available', ErrorCode.InvalidState); };
  }
})();

const DEFAULT_NAME = 'default';

/** Observed-remove CRDT map of values and references. */
export class ORMap<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements AggregateRoot<ORMapCommand<Ref, V>, AsyncIterable<[string, Ref | V]>, ORMapEvent<Ref, V>, ORMapQuery>
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

  public async command(command: ORMapCommand<Ref, V>, options?: AbortOptions): Promise<ORMapEvent<Ref, V>> {
    const voidRef = this.voidRef();
    const name = command.name ?? DEFAULT_NAME;
    const fields = Object.keys(command.set);
    const set: [string, Ref | V, ...number[]][] = [];
    const parents: Ref[] = [];
    const parentsMap: Record<string, number> = {};

    for (const field of fields) {
      const value = command.set[field];

      const thisParents: number[] = [];
      for await (const parentRef of this.store.values({
        gt: getHeadIndexKey(name, field),
        lt: getPrefixEndKey(getHeadIndexKey(name, field)),
      })) {
        if (this.isRef(parentRef)) {
          const parentRefStr = `${parentRef}`;
          thisParents.push(parentsMap[parentRefStr] ?? (parents.push(parentRef) - 1));
          parentsMap[parentRefStr] = thisParents[thisParents.length - 1];
        }
      }

      if (this.isRef(value) && equalsOrSameString(value, voidRef) && !thisParents.length) {
        continue; // nothing to delete
      }

      set.push([field, value, ...thisParents]);
    }

    if (!fields.length) {
      throw operationError('Empty operation', ErrorCode.InvalidArg);
    }

    let root: Ref | undefined;
    for await (const rootRef of this.store.getMany([getHeadIndexKey(name)], options)) {
      if (this.isRef(rootRef)) {
        root = rootRef;
      }
    }

    return {
      type: this.event.Set,
      payload: { name, set },
      meta: { parents, root, createdAt: command.createdAt }
    };
  }

  public async apply(event: ORMapEvent<Ref, V>, options?: AggregateApplyOptions): Promise<void> {
    if (options?.validate ?? true) {
      const error = await this.validate(event, options);
      if (error) {
        throw error;
      }
    }

    const voidRef = this.voidRef();
    const eventKey = await this.eventRef(event, options);
    const eventKeyStr = `${eventKey}`;

    // save event time and root event
    const entries: [string, (Ref | V | number)?][] = [
      [getEventIndexKey(eventKeyStr), event.meta.createdAt || 0],
      [getHeadIndexKey(event.payload.name), event.meta.root ?? eventKey],
    ];

    // update field values
    for (const [field, value, ...parents] of event.payload.set) {
      if (!(this.isRef(value) && equalsOrSameString(voidRef, value))) {
        entries.push(
          [getHeadIndexKey(event.payload.name, field, eventKeyStr), eventKey],
          [getFieldValueKey(event.payload.name, field, eventKeyStr), value],
        );
      }
      for (const parentIndex of parents) {
        const parentRef = `${event.meta.parents[parentIndex]}`;
        entries.push(
          [getHeadIndexKey(event.payload.name, field, parentRef), void 0],
          [getFieldValueKey(event.payload.name, field, parentRef), void 0]
        );
      }
    }

    for await (const error of this.store.updateMany(entries, options)) {
      if (error) {
        throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error);
      }
    }
  }

  public async validate(event: ORMapEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    if (event.type !== this.event.Set) {
      return operationError('Unsupported event type', ErrorCode.UnsupportedOp);
    }

    if (!event.payload.set.length) {
      return operationError('Empty operation', ErrorCode.InvalidArg);
    }

    // verify that set operations are well formed
    const voidRef = this.voidRef();
    for (const [field, value, ...parents] of event.payload.set) {
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

  public query(options?: ORMapQuery): AsyncIterable<[string, Ref | V]> {
    return options?.lww ? this.queryLWW(options) : this.queryMV(options);
  }

  /** Query map entries and return all concurrent field values. */
  protected async * queryMV(options?: ORMapQuery): AsyncIterable<[string, Ref | V]> {
    const name = options?.name ?? DEFAULT_NAME;
    const limit = options?.limit ?? Infinity;
    let currentField: string | undefined;
    let fieldCount = 0;
    for await (const [key, value] of this.store.entries({
      gt: getFieldValueKey(name, options?.gte),
      lt: getPrefixEndKey(getFieldValueKey(name, options?.lte)),
      reverse: options?.reverse,
    })) {
      const field = getFieldNameFromKey(key);
      if (field) {
        if (currentField !== field) {
          currentField = field;
          if (++fieldCount > limit) {
            break;
          }
        }
        yield [field, value as (Ref | V)];
      }
    }
  }

  /** Queries entries by last-write-wins. */
  protected async * queryLWW(options?: ORMapQuery): AsyncIterable<[string, Ref | V]> {
    const name = options?.name ?? DEFAULT_NAME;
    const limit = options?.limit ?? Infinity;

    // Get concurrent event refs for each field
    const fields: [name: string, eventRefs: string[]][] = [];
    let currentField: string | undefined;
    for await (const [key, value] of this.store.entries({
      gt: getHeadIndexKey(name, options?.gte),
      lt: getPrefixEndKey(getHeadIndexKey(name, options?.lte)),
      reverse: options?.reverse,
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
      lwwRef && lwwKeys.push(getFieldValueKey(name, field, lwwRef));
    }

    // query the values for each LWW event reference
    let i = 0;
    for await (const value of this.store.getMany(lwwKeys, options)) {
      if (value !== void 0) {
        yield [getFieldNameFromKey(lwwKeys[i]), value as (Ref | V)];
      }
      ++i;
    }
  }
}

/** Event type for {@link ORMap}. */
export enum ORMapEventType {
  /** Sets or deletes map fields. */
  Set = 'MAP_SET',
}

/** Query options for {@link ORMap}.  */
export interface ORMapQuery extends AbortOptions {
  /** Unique name of the map. Defaults to `default`. */
  name?: string;

  /** Whether to resolve concurrent values by last-write-wins using createdAt time. Defaults to `true`. */
  lww?: boolean;

  /** Returns only entries with field names greater than or equal to given name. */
  gte?: string;

  /** Returns only entries with field names less than or equal to given name. */
  lte?: string;

  /** Returns entries in reverse order. */
  reverse?: boolean;

  /** Maximum number of results to return. Defaults to `Infinity`. */
  limit?: number;
}

/** Command for {@link ORMap}. */
export interface ORMapCommand<Ref, V> {
  /** Unique string name that identifies this map. Defaults to `default`. */
  name?: string;

  /** Sets given field-value pairs to the map. */
  set: Readonly<Record<string, Ref | V>>;

  /** Timestamp of this command. */
  createdAt?: number;
}

/** Event for {@link ORMap}. */
export type ORMapEvent<Ref, V> = AggregateEvent<ORMapEventType, Ref, ORMapEventPayload<Ref, V>>;

/** Event payload for {@link ORMap}. */
export interface ORMapEventPayload<Ref, V> {
  /** Unique string name that identifies this map. */
  readonly name: string;

  /** Operations to set given field pairs to the map with references to parent event indices. */
  readonly set: readonly [field: string, value: Ref | V, ...parentIndices: number[]][];
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
