import { AbortOptions, CodedError, ContentId, StringEquatable } from '@mithic/commons';
import { AggregateApplyOptions, AggregateCommandMeta, AggregateEvent, AggregateRoot } from '../aggregate.js';
import { ORMap, ORMapCommand, ORMapEvent, ORMapEventPayload, ORMapQuery } from './map.js';
import { defaultVoidRef } from './defaults.js';
import { getFractionalIndices } from './keys.js';

/** Linear sequence of values based on {@link ORMap} of base64 fractional index to values. */
export class LSeq<
  Ref extends StringEquatable<Ref> = ContentId,
  V = string | number | boolean | null
> implements AggregateRoot<LSeqCommand<Ref, V>, AsyncIterable<[string, V]>, LSeqEvent<Ref, V>, ORMapQuery<Ref>>
{
  protected readonly map: ORMap<Ref, V>;
  protected readonly voidRef: () => Ref;
  protected readonly rand: () => number;
  protected readonly indexRandomness: number;

  public readonly event = LSeqEventType;

  public constructor({
    map = new ORMap(),
    voidRef = defaultVoidRef,
    rand = Math.random,
    indexRandomness = 2,
  }: LSeqOptions<Ref, V> = {}) {
    this.map = map;
    this.voidRef = voidRef;
    this.rand = rand;
    this.indexRandomness = indexRandomness;
  }

  public query(options?: ORMapQuery<Ref>): AsyncIterable<[string, V]> {
    return this.map.query(options);
  }

  public async command(command: LSeqCommand<Ref, V> = {}, options?: AbortOptions): Promise<LSeqEvent<Ref, V>> {
    const type = command.ref === void 0 ? this.event.New : this.event.Update;
    const toDeleteCount = type === this.event.New ? 0 : command.del || 0;
    const voidRef = this.voidRef();
    const entries: Record<string, Ref | V> = {};
    const mapCmd: ORMapCommand<Ref, V> = {
      ref: command.ref,
      createdAt: command.createdAt,
      nounce: command.nounce,
      entries,
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
      entries[deletedIndices[i]] = i < adds.length ? adds[i] : voidRef;
    }
    if (i < adds.length) {
      startIndex = deletedIndices[i - 1] || startIndex;
      for (const index of getFractionalIndices(startIndex, endIndex, adds.length - i, this.rand)) {
        entries[index] = adds[i++];
      }
    }

    const mapEvent = await this.map.command(mapCmd, options);
    return { ...mapEvent, type };
  }

  public async apply(event: LSeqEvent<Ref, V>, options?: AggregateApplyOptions): Promise<void> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.apply(mapEvent, options);
  }

  public async validate(event: LSeqEvent<Ref, V>, options?: AbortOptions): Promise<CodedError<Ref[]> | undefined> {
    const mapEvent = this.toORMapEvent(event);
    return this.map.validate(mapEvent, options);
  }

  protected toORMapEvent(event: LSeqEvent<Ref, V>): ORMapEvent<Ref, V> {
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
export type LSeqEvent<Ref, V> = AggregateEvent<LSeqEventType, Ref, ORMapEventPayload<Ref, V>>;

/** Options for creating an {@link LSeq}. */
export interface LSeqOptions<Ref extends StringEquatable<Ref>, V> {
  /** Backing {@link ORMap}. */
  readonly map?: ORMap<Ref, V>;

  /** Creates a void reference. */
  readonly voidRef?: () => Ref;

  /** Returns a random number from 0 to 1 (exclusive). */
  readonly rand?: () => number;

  /**
   * Related to the number of random bits to use when generating random indices.
   * Defaults to `2`, which represents 2 * 24 bits = 48 bits.
   */
  readonly indexRandomness?: number;
}
