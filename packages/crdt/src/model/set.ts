import {
  AbortOptions, CodedError, ContentId, MaybePromise, StringEquatable, SyncOrAsyncIterable
} from '@mithic/commons';
import { AggregateApplyOptions, AggregateCommandMeta, AggregateEvent, Aggregate } from '../aggregate.js';
import { ORMap, MapCommand, MapEvent, MapAggregate } from './map.js';

/** Abstract set aggregate type. */
export type SetAggregate<Ref, V> =
  Aggregate<SetCommand<Ref, V>, Ref, SetEvent<Ref, V>, SyncOrAsyncIterable<V>, SetQuery<Ref, V>>;

/** Observed-remove set of values based on {@link ORMap} of stringified values to values. */
export class ORSet<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements SetAggregate<Ref, V> {
  protected readonly map: MapAggregate<Ref, V>;
  protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string>;

  public readonly event = SetEventType;

  public constructor({
    map = new ORMap(),
    stringify = (value) => JSON.stringify(value),
  }: ORSetOptions<Ref, V> = {}) {
    this.map = map;
    this.stringify = stringify;
  }

  public async * query(options?: SetQuery<Ref, V>): AsyncIterable<V> {
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

  public async command(command: SetCommand<Ref, V> = {}, options?: AbortOptions): Promise<SetEvent<Ref, V>> {
    const type = command.ref === void 0 ? this.event.New : this.event.Update;
    const values: Record<string, V> = {};
    const set: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<Ref, V> = {
      ref: command.ref,
      createdAt: command.createdAt,
      nonce: command.nonce,
      set,
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
      set[hash] = value;
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
      payload: { ops, nonce: mapEvent.payload.nonce },
      meta: mapEvent.meta,
    };
  }

  public async apply(event: SetEvent<Ref, V>, options?: AggregateApplyOptions): Promise<Ref> {
    const mapEvent = await this.toORMapEvent(event, options);
    return this.map.apply(mapEvent, options);
  }

  public async validate(event: SetEvent<Ref, V>, options?: AbortOptions): Promise<CodedError | undefined> {
    const mapEvent = await this.toORMapEvent(event, options);
    return this.map.validate(mapEvent, options);
  }

  protected async toORMapEvent(event: SetEvent<Ref, V>, options?: AbortOptions): Promise<MapEvent<Ref, V>> {
    const ops: [string, V, boolean, ...number[]][] = [];
    for (const [value, ...parents] of event.payload.ops) {
      const hash = await this.stringify(value, options);
      ops.push([hash, value, !!parents.length, ...parents]);
    }

    return {
      type: event.type === this.event.New ? this.map.event.New : this.map.event.Update,
      payload: { ops, nonce: event.payload.nonce },
      meta: event.meta,
    };
  }
}

/** Event type for {@link SetAggregate}. */
export enum SetEventType {
  /** Creates a new set. */
  New = 'SET_NEW',

  /** Adds or deletes values in the set. */
  Update = 'SET_OPS',
}

/** Query options for {@link SetAggregate}.  */
export interface SetQuery<Ref, V> extends AbortOptions {
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

/** Command for {@link SetAggregate}. */
export interface SetCommand<Ref, V> extends AggregateCommandMeta<Ref> {
  /** Adds given values to the set. */
  readonly add?: readonly V[];

  /** Deletes given values from the set. */
  readonly del?: readonly V[];
}

/** Event for {@link SetAggregate}. */
export type SetEvent<Ref, V> = AggregateEvent<SetEventType, Ref, SetEventPayload<V>>;

/** Event payload for {@link SetAggregate}. */
export interface SetEventPayload<V> {
  /** Operations to add or delete given values in the set. */
  readonly ops: readonly [value: V, ...parentIdxToDelete: number[]][];

  /** A random number to make a unique event when creating a new set. */
  readonly nonce?: number;
}

/** Options for creating an {@link ORSet}. */
export interface ORSetOptions<Ref extends StringEquatable<Ref>, V> {
  /** Backing {@link MapAggregate}. */
  readonly map?: MapAggregate<Ref, V>;

  /** Function for converting value to unique string. Defaults to `JSON.stringify`. */
  readonly stringify?: (value: V, options?: AbortOptions) => MaybePromise<string>;
}
