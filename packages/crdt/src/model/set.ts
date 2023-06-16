import { AbortOptions, CodedError, ContentId, MaybePromise, StringEquatable } from '@mithic/commons';
import { AggregateApplyOptions, AggregateCommandMeta, AggregateEvent, AggregateRoot } from '../aggregate.js';
import { ORMap, ORMapCommand, ORMapEvent } from './map.js';

/** Observed-remove set of values based on {@link ORMap} of stringified values to values. */
export class ORSet<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements AggregateRoot<ORSetCommand<Ref, V>, AsyncIterable<V>, ORSetEvent<Ref, V>, ORSetQuery<Ref, V>>
{
  protected readonly map: ORMap<Ref, V>;
  protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string>;

  public readonly event = ORSetEventType;

  public constructor({
    map = new ORMap(),
    stringify = (value) => JSON.stringify(value),
  }: ORSetOptions<Ref, V> = {}) {
    this.map = map;
    this.stringify = stringify;
  }

  public async * query(options?: ORSetQuery<Ref, V>): AsyncIterable<V> {
    if (!options) { return; }

    const gte = options.gte && await this.stringify(options.gte, options);
    const lte = options.lte && await this.stringify(options.lte, options);
    let currentHash: string | undefined;

    for await (const [hash, value] of this.map.query({
      gte, lte,
      ref: options.ref,
      reverse: options.reverse,
      limit: options.limit,
      signal: options.signal,
    })) {
      if (currentHash !== hash) {
        currentHash = hash;
        yield value as V;
      }
    }
  }

  public async command(command: ORSetCommand<Ref, V> = {}, options?: AbortOptions): Promise<ORSetEvent<Ref, V>> {
    const type = command.ref === void 0 ? this.event.New : this.event.Update;
    const values: Record<string, V> = {};
    const entries: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: ORMapCommand<Ref, V> = {
      ref: command.ref,
      createdAt: command.createdAt,
      nounce: command.nounce,
      entries,
      del,
    };

    for (const value of command.del || []) {
      const hash = await this.stringify(value, options);
      values[hash] = value;
      del.push(hash);
    }
    for (const value of command.add || []) {
      const hash = await this.stringify(value, options);
      values[hash] = value;
      entries[hash] = value;
    }

    const mapEvent = await this.map.command(mapCmd, options);
    const ops: [V, ...number[]][] = [];
    for (const [hash, _, isDelete, ...parents] of mapEvent.payload.ops) {
      if (isDelete) {
        ops.push([values[hash], ...parents]);
      } else if (!parents.length) { // add *new* value
        ops.push([values[hash]]);
      }
    }

    return {
      type,
      payload: { ops, nounce: mapEvent.payload.nounce },
      meta: mapEvent.meta,
    };
  }

  public async apply(event: ORSetEvent<Ref, V>, options?: AggregateApplyOptions): Promise<void> {
    const mapEvent = await this.toORMapEvent(event, options);
    return this.map.apply(mapEvent, options);
  }

  public async validate(event: ORSetEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    const mapEvent = await this.toORMapEvent(event, options);
    return this.map.validate(mapEvent, options);
  }

  protected async toORMapEvent(event: ORSetEvent<Ref, V>, options?: AbortOptions): Promise<ORMapEvent<Ref, V>> {
    const ops: [string, V, boolean, ...number[]][] = [];
    for (const [value, ...parents] of event.payload.ops) {
      const hash = await this.stringify(value, options);
      ops.push([hash, value, !!parents.length, ...parents]);
    }

    return {
      type: event.type === this.event.New ? this.map.event.New : this.map.event.Update,
      payload: { ops, nounce: event.payload.nounce },
      meta: event.meta,
    };
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
export interface ORSetCommand<Ref, V> extends AggregateCommandMeta<Ref> {
  /** Adds given values to the set. */
  readonly add?: readonly V[];

  /** Deletes given values from the set. */
  readonly del?: readonly V[];
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
export interface ORSetOptions<Ref extends StringEquatable<Ref>, V> {
  /** Backing {@link ORMap}. */
  readonly map?: ORMap<Ref, V>;

  /** Function for converting value to unique string. Defaults to `JSON.stringify`. */
  readonly stringify?: (value: V, options?: AbortOptions) => MaybePromise<string>;
}
