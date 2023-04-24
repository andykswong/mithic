import { MaybeAsyncAppendOnlySet } from '../set.js';
import { fnv1aHash, kHash } from './hash.js';

/** A simple bloom filter implementation. */
export class BloomFilter<T> implements MaybeAsyncAppendOnlySet<T> {
  private readonly m: number;
  private readonly k: number;
  private readonly hash: (value: T, seed: number) => number;
  private value: bigint;
  private n: number;

  public constructor({
    m,
    k,
    hash = kHash((value) => fnv1aHash(`${value}`)),
    value = 0n,
    n = 0
  }: BloomFilterOptions<T>
  ) {
    this.m = m;
    this.k = k;
    this.hash = hash;
    this.value = BigInt(value);
    this.n = n;
  }

  /** Returns the approximate number of elements in the bloom filter. */
  public get size(): number {
    return this.n;
  }

  /** Returns the false positive rate of the bloom filter = `(1 - e^(-kn/m))^k`. */
  public get rate(): number {
    const x = (this.k * this.n) / this.m;
    return Math.pow(1 - Math.exp(-x), this.k);
  }

  /** Clears the bloom filter. */
  public clear(): void {
    this.value = 0n;
    this.n = 0;
  }

  public add(value: T): this {
    if (this.has(value)) {
      return this;
    }

    for (let i = 0; i < this.k; i++) {
      const index = this.hash(value, i) % this.m;
      const bit = 1n << BigInt(index);

      this.value |= bit;
    }
    ++this.n;
    return this;
  }

  /**
   * Returns false if the bloom filter definitely does not contain the given value;
   * true if it probably contains the value;
   */
  public has(value: T): boolean {
    for (let i = 0; i < this.k; i++) {
      const index = this.hash(value, i) % this.m;
      const bit = 1n << BigInt(index);

      if ((this.value & bit) === 0n) {
        return false;
      }
    }
    return true;
  }

  public toJSON(): BloomFilterJSON {
    return {
      value: `0x${this.value.toString(16)}`,
      m: this.m,
      k: this.k,
      n: this.n
    };
  }

  public get [Symbol.toStringTag](): string {
    return BloomFilter.name;
  }
}

/** The JSON representation of a {@link BloomFilter}. */
export interface BloomFilterJSON {
  /** The hexstring bit value of the bloom filter. */
  value: string;
  /** The bit size of the bloom filter. */
  m: number;
  /** The number of hash functions to use. */
  k: number;
  /** The number of elements in the bloom filter. */
  n: number;
}

/** Options for creating a {@link BloomFilter}. */
export interface BloomFilterOptions<T> {
  /** The bit size of the bloom filter. */
  m: number;

  /** The number of hash functions to use. */
  k: number;

  /** The k hash functions */
  hash?: (value: T, seed: number) => number;

  /** The initial bit value of the bloom filter. */
  value?: bigint | number | string;

  /** The initial number of elements in the bloom filter. */
  n?: number;
}
