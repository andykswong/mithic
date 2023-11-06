import { AbortOptions, ContentId, StringEquatable, SyncOrAsyncIterable } from '@mithic/commons';
import { AggregateReduceOptions, Aggregate } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../event.js';
import { ORMap, MapCommand, MapEvent, MapEventPayload, MapQuery, MapAggregate, MapEventType, MapCommandType } from './map.js';
import { getFractionalIndices } from './keys.js';

/** Linear sequence of values based on {@link ORMap} of base64 fractional index to values. */
export class LSeqAggregate<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements Aggregate<LSeqCommand<Ref, V>, LSeqEvent<Ref, V>, MapQuery<Ref, V>>
{
  protected readonly map: MapAggregate<Ref, V>;
  protected readonly rand: () => number;
  protected readonly indexRandBits: number;

  public constructor({
    map = new ORMap(),
    rand = Math.random,
    indexRandBits = 48,
  }: LSeqOptions<Ref, V> = {}) {
    this.map = map;
    this.rand = rand;
    this.indexRandBits = indexRandBits;
  }

  public query(query: MapQuery<Ref, V>, options?: AbortOptions): SyncOrAsyncIterable<[string, V]> {
    return this.map.query(query, options);
  }

  public async command(command: LSeqCommand<Ref, V>, options?: AbortOptions): Promise<LSeqEvent<Ref, V>> {
    const type = command.meta?.root === void 0 ? LSeqEventType.New : LSeqEventType.Update;
    const toDeleteCount = type === LSeqEventType.New ? 0 : command.payload.del || 0;
    const set: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<Ref, V> = {
      type: MapCommandType.Update,
      payload: { set, del },
      meta: command.meta,
    };

    const deletedIndices: string[] = [];
    let startIndex = command.payload.index;
    let endIndex;

    if (command.meta?.root) {
      let currentIndex: string | undefined;
      let indexCount = 0;
      for await (const [index] of this.map.query({
        root: command.meta.root,
        gte: startIndex,
        limit: toDeleteCount + 1,
      }, options)) {
        if (currentIndex !== index) {
          currentIndex = index;
          if (indexCount++ < toDeleteCount) {
            deletedIndices.push(index);
          }
          if (indexCount === toDeleteCount + 1) {
            endIndex = index;
          }
        }
      }
    }

    let i = 0;
    const adds = command.payload.add || [];
    for (; i < deletedIndices.length; ++i) {
      if (i < adds.length) {
        set[deletedIndices[i]] = adds[i];
      } else {
        del.push(deletedIndices[i]);
      }
    }
    if (i < adds.length) {
      startIndex = deletedIndices[i - 1] || startIndex;
      for (const index of getFractionalIndices(startIndex, endIndex, adds.length - i, this.rand, this.indexRandBits)) {
        set[index] = adds[i++];
      }
    }

    const mapEvent = await this.map.command(mapCmd, options);
    return { ...mapEvent, type };
  }

  public async reduce(event: LSeqEvent<Ref, V>, options?: AggregateReduceOptions): Promise<Ref> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.reduce(mapEvent, options);
  }

  public async validate(event: LSeqEvent<Ref, V>, options?: AbortOptions): Promise<Error | undefined> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.validate(mapEvent, options);
  }

  protected toORMapEvent(event: LSeqEvent<Ref, V>): MapEvent<Ref, V> {
    return { ...event, type: event.type === LSeqEventType.New ? MapEventType.New : MapEventType.Update };
  }
}

/** Command type for {@link LSeqAggregate}. */
export enum LSeqCommandType {
  /** Sets or deletes set fields. */
  Update = 'LSEQ_OPS',
}

/** Event type for {@link LSeqAggregate}. */
export enum LSeqEventType {
  /** Creates a new lseq. */
  New = 'LSEQ_NEW',

  /** Inserts or deletes values in the lseq. */
  Update = 'LSEQ_OPS',
}

/** Command for {@link LSeqAggregate}. */
export type LSeqCommand<Ref, V> = StandardCommand<LSeqCommandType, LSeqCommandPayload<V>, Ref>;

/** Command payload for {@link LSeqAggregate}. */
export interface LSeqCommandPayload<V> {
  /** The base64 fractional index at which insertion or deletion should occur. Defaults to the start. */
  readonly index?: string;

  /** Inserts given sequence of values at specified index. */
  readonly add?: readonly V[];

  /** Deletes given number of values at specified index. */
  readonly del?: number;
}

/** Event for {@link LSeqAggregate}. */
export type LSeqEvent<Ref, V> = StandardEvent<LSeqEventType, MapEventPayload<V>, Ref>;

/** Options for creating an {@link LSeqAggregate}. */
export interface LSeqOptions<Ref extends StringEquatable<Ref>, V> {
  /** Backing {@link MapAggregate}. */
  readonly map?: MapAggregate<Ref, V>;

  /** Returns a random number from 0 to 1 (exclusive). */
  readonly rand?: () => number;

  /**
   *The number of random bits to use when generating random indices.
   * Defaults to 48 bits.
   */
  readonly indexRandBits?: number;
}
