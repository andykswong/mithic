import { MaybePromise } from '@mithic/commons';
import { type KeyResponse, type KeySelector } from '../types.ts';
import type { KeyValueStore } from '../provider/index.ts';

/**
 * Abstract base class for {@link KeyValueStore}.
 */
export abstract class BaseKeyValueStore implements KeyValueStore {
  public abstract open(identifier: string): MaybePromise<string>;
  public abstract close(bucket: string): MaybePromise<void>;
  public abstract listKeys(bucket: string, selector?: KeySelector, cursor?: string): MaybePromise<KeyResponse>;
  public abstract getMany(bucket: string, keys: string[]): MaybePromise<(Uint8Array | null)[]>;
  public abstract updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): MaybePromise<void>;
  public abstract increment(bucket: string, key: string, delta: bigint): MaybePromise<bigint>;
  public abstract compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): MaybePromise<boolean>;

  public exists(bucket: string, key: string): MaybePromise<boolean> {
    return MaybePromise.map(this.getMany(bucket, [key]), exists);
  }

  protected get(bucket: string, key: string): MaybePromise<Uint8Array | null> {
    return MaybePromise.map(this.getMany(bucket, [key]), getFirst);
  }

  protected keyInRange(key: string, selector?: KeySelector): boolean {
    if (selector?.start !== undefined && key < selector.start) { return false; }
    if (selector?.end !== undefined && key >= selector.end) { return false; }
    return true;
  }
}

function getFirst(results: Iterable<(Uint8Array | null)>): Uint8Array | null {
  for (const result of results) {
    return result;
  }
  return null;
}

function exists(results: Iterable<(Uint8Array | null)>): boolean {
  return !!getFirst(results);
}
