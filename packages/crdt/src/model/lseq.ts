import { AbortOptions, CodedError, ContentId, StringEquatable, SyncOrAsyncIterable } from '@mithic/commons';
import { AggregateApplyOptions, AggregateCommandMeta, AggregateEvent, Aggregate } from '../aggregate.js';
import { ORMap, MapCommand, MapEvent, MapEventPayload, MapQuery, MapAggregate } from './map.js';
import { getFractionalIndices } from './keys.js';

/** Linear sequence of values based on {@link ORMap} of base64 fractional index to values. */
export class LSeq<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements Aggregate<LSeqCommand<Ref, V>, Ref, LSeqEvent<Ref, V>, SyncOrAsyncIterable<[string, V]>, MapQuery<Ref>>
{
  protected readonly map: MapAggregate<Ref, V>;
  protected readonly rand: () => number;
  protected readonly indexRandBits: number;

  public readonly event = LSeqEventType;

  public constructor({
    map = new ORMap(),
    rand = Math.random,
    indexRandBits = 48,
  }: LSeqOptions<Ref, V> = {}) {
    this.map = map;
    this.rand = rand;
    this.indexRandBits = indexRandBits;
  }

  public query(options?: MapQuery<Ref>): SyncOrAsyncIterable<[string, V]> {
    return this.map.query(options);
  }

  public async command(command: LSeqCommand<Ref, V> = {}, options?: AbortOptions): Promise<LSeqEvent<Ref, V>> {
    const type = command.ref === void 0 ? this.event.New : this.event.Update;
    const toDeleteCount = type === this.event.New ? 0 : command.del || 0;
    const set: Record<string, V> = {};
    const del: string[] = [];
    const mapCmd: MapCommand<Ref, V> = {
      ref: command.ref,
      createdAt: command.createdAt,
      nonce: command.nonce,
      set,
      del,
    };

    const deletedIndices: string[] = [];
    let startIndex = command.index;
    let endIndex;

    if (command.ref) {
      let currentIndex: string | undefined;
      let indexCount = 0;
      for await (const [index] of this.map.query({
        ref: command.ref,
        gte: startIndex,
        limit: toDeleteCount + 1,
        signal: options?.signal,
      })) {
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
    const adds = command.add || [];
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

  public async apply(event: LSeqEvent<Ref, V>, options?: AggregateApplyOptions): Promise<Ref> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.apply(mapEvent, options);
  }

  public async validate(event: LSeqEvent<Ref, V>, options?: AbortOptions): Promise<CodedError | undefined> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.validate(mapEvent, options);
  }

  protected toORMapEvent(event: LSeqEvent<Ref, V>): MapEvent<Ref, V> {
    return { ...event, type: event.type === this.event.New ? this.map.event.New : this.map.event.Update };
  }
}

/** Event type for {@link LSeq}. */
export enum LSeqEventType {
  /** Creates a new lseq. */
  New = 'LSEQ_NEW',

  /** Inserts or deletes values in the lseq. */
  Update = 'LSEQ_OPS',
}

/** Command for {@link LSeq}. */
export interface LSeqCommand<Ref, V> extends AggregateCommandMeta<Ref> {
  /** The base64 fractional index at which insertion or deletion should occur. Defaults to the start. */
  readonly index?: string;

  /** Inserts given sequence of values at specified index. */
  readonly add?: readonly V[];

  /** Deletes given number of values at specified index. */
  readonly del?: number;
}

/** Event for {@link LSeq}. */
export type LSeqEvent<Ref, V> = AggregateEvent<LSeqEventType, Ref, MapEventPayload<V>>;

/** Options for creating an {@link LSeq}. */
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
