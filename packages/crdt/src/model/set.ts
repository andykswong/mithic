import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, StringEquatable, operationError
} from '@mithic/commons';
import { AggregateApplyOptions, AggregateEvent, AggregateRoot } from '../aggregate.js';
import { BTreeMap, MaybeAsyncMapBatch, RangeQueryable } from '@mithic/collections';
import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from './keys.js';
import { defaultEventRef } from './defaults.js';

/** Observed-remove set of values and references. */
export class ORSet<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean
>
  implements AggregateRoot<ORSetCommand<Ref, V>, AsyncIterable<Ref | V>, ORSetEvent<Ref, V>, ORSetQuery<Ref, V>>
{
  protected readonly store: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;
  protected readonly eventRef: (event: ORSetEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;
  protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string>;

  public readonly event = ORSetEventType;

  public constructor({
    store = new BTreeMap<string, V>(5),
    eventRef = defaultEventRef,
    stringify = (value) => JSON.stringify(value),
  }: ORSetOptions<Ref, V>) {
    this.store = store;
    this.eventRef = eventRef;
    this.stringify = stringify;
  }

  public async * query(options?: ORSetQuery<Ref, V>): AsyncIterable<Ref | V> {
    if (!options) { return }

    const root = `${options.ref}`;
    const limit = options.limit ?? Infinity;
    const gte = options.gte && await this.stringify(options.gte, options);
    const lte = options.lte && await this.stringify(options.lte, options);
    let currentHash: string | undefined;
    let valueCount = 0;

    for await (const [key, value] of this.store.entries({
      gt: getFieldValueKey(root, gte),
      lt: getPrefixEndKey(getFieldValueKey(root, lte)),
      reverse: options.reverse,
      signal: options.signal,
    })) {
      const hash = getFieldNameFromKey(key);
      if (hash && currentHash !== hash) {
        currentHash = hash;
        if (++valueCount > limit) {
          break;
        }
        yield value as V;
      }
    }
  }

  public async command(command: ORSetCommand<Ref, V> = {}, options?: AbortOptions): Promise<ORSetEvent<Ref, V>> {
    const rootRef = command.ref;
    const rootRefStr = `${rootRef}`;
    const type = rootRef === void 0 ? this.event.New : this.event.Update;
    const ops: [V, ...number[]][] = [];

    const entries = [
      ...(command.add || []).map(value => [value, true] as [value: V, add: boolean]),
      ...(command.del || []).map(value => [value, false] as [value: V, add: boolean]),
    ];

    const parents: Ref[] = [];
    const parentsMap: Record<string, number> = {};

    for (const [value, isAdd] of entries) {
      const hash = await this.stringify(value, options);
      const thisParents: number[] = [];

      if (type === this.event.Update) { // find parents for updated value
        for await (const parentRef of this.store.values({
          gt: getHeadIndexKey(rootRefStr, hash),
          lt: getPrefixEndKey(getHeadIndexKey(rootRefStr, hash)),
          signal: options?.signal,
        })) {
          const parentRefStr = `${parentRef}`;
          thisParents.push(parentsMap[parentRefStr] ?? (parents.push(parentRef as Ref) - 1));
          parentsMap[parentRefStr] = thisParents[thisParents.length - 1];
        }
      }
      if ((!isAdd && !thisParents.length) || (isAdd && thisParents.length)) {
        continue;  // nothing to delete or already added
      }

      ops.push([value, ...thisParents]);
    }

    if (type === this.event.Update && !entries.length) {
      throw operationError('Empty operation', ErrorCode.InvalidArg);
    }

    return {
      type,
      payload: { ops, nounce: type === this.event.New ? command.nounce : void 0 },
      meta: { parents, root: rootRef, createdAt: command.createdAt }
    };
  }

  public async apply(event: ORSetEvent<Ref, V>, options?: AggregateApplyOptions): Promise<void> {
    if (options?.validate ?? true) {
      const error = await this.validate(event, options);
      if (error) { throw error; }
    }

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
    for (const [value, ...parentsToDel] of event.payload.ops) {
      const hash = await this.stringify(value, options);
      if (!parentsToDel.length) { // add
        entries.push(
          [getHeadIndexKey(rootRefStr, hash, eventKeyStr), eventKey],
          [getFieldValueKey(rootRefStr, hash, eventKeyStr), value],
        );
      }
      for (const parentIndex of parentsToDel) { // delete
        const parentRef = `${event.meta.parents[parentIndex]}`;
        entries.push(
          [getHeadIndexKey(rootRefStr, hash, parentRef), void 0],
          [getFieldValueKey(rootRefStr, hash, parentRef), void 0]
        );
      }
    }

    for await (const error of this.store.updateMany(entries, options)) {
      if (error) { throw operationError('Failed to save indices', ErrorCode.OpFailed, void 0, error); }
    }
  }

  public async validate(event: ORSetEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    if (event.type === this.event.Update) {
      if (!event.payload.ops.length) {
        return operationError('Empty operation', ErrorCode.InvalidArg);
      }
      if (event.meta.root === void 0) {
        return operationError('Missing root', ErrorCode.InvalidArg);
      }
    }

    // verify that delete operations have valid parents
    for (const [value, ...parentsToDel] of event.payload.ops) {
      let isValid = true;
      for (const parent of parentsToDel) {
        if (event.meta.parents[parent] === void 0) {
          isValid = false;
          break;
        }
      }
      if (!isValid) {
        return operationError(`Invalid delete operation: "${value}"`, ErrorCode.InvalidArg);
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
}

/** Event type for {@link ORSet}. */
export enum ORSetEventType {
  /** Creates a new set. */
  New = 'SET_NEW',

  /** Adds or deletes values in the set. */
  Update = 'SET_OPS',
}

/** Query options for {@link ORSet}.  */
export interface ORSetQuery<Ref, V> extends AbortOptions {
  /** Reference to (root event of) the set. */
  readonly ref: Ref;

  /** Returns only value greater than or equal to given value. */
  readonly gte?: V;

  /** Returns only value less than or equal to given value. */
  readonly lte?: V;

  /** Returns values in reverse order. */
  readonly reverse?: boolean;

  /** Maximum number of results to return. Defaults to `Infinity`. */
  readonly limit?: number;
}

/** Command for {@link ORSet}. */
export interface ORSetCommand<Ref, V> {
  /** Reference to (root event of) the set. */
  readonly ref?: Ref;

  /** Adds given values to the set. */
  readonly add?: readonly V[];

  /** Deletes given values from the set. */
  readonly del?: readonly V[];

  /** Timestamp of this command. */
  readonly createdAt?: number;

  /** A random number to make a unique event when creating a new set. */
  readonly nounce?: number;
}

/** Event for {@link ORSet}. */
export type ORSetEvent<Ref, V> = AggregateEvent<ORSetEventType, Ref, ORSetEventPayload<V>>;

/** Event payload for {@link ORSet}. */
export interface ORSetEventPayload<V> {
  /** Operations to add or delete given values in the set. */
  readonly ops: readonly [value: V, ...parentIdxToDelete: number[]][];

  /** A random number to make a unique event when creating a new set. */
  readonly nounce?: number;
}

/** Options for creating an {@link ORSet}. */
export interface ORSetOptions<Ref, V> {
  /** Backing data store. */
  readonly store?: MaybeAsyncMapBatch<string, Ref | V | number> & RangeQueryable<string, Ref | V | number>;

  /** Gets the reference to event from given event. */
  readonly eventRef?: (event: ORSetEvent<Ref, V>, options?: AbortOptions) => MaybePromise<Ref>;

  /** Function for converting value to unique string. Defaults to `JSON.stringify`. */
  readonly stringify?: (value: V, options?: AbortOptions) => MaybePromise<string>;
}
