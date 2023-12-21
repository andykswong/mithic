import { IndexGenerator } from './generator.js';

const ASCII64_DIGIT = '+/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~';

/** Generator of random fractional index strings. */
export class FractionalIndexGenerator implements IndexGenerator<string> {
  public constructor(
    /** The random function. Defaults to Math.random. */
    protected readonly rand: () => number = Math.random,
    /** Number of random bits to use when generating random indices. Defaults to 48 bits. */
    protected readonly minRandBits = 48,
  ) { }

  public * create(start?: string, end?: string, count = 1): IterableIterator<string> {
    const endBytes = [...(end || ASCII64_DIGIT[64])].map(char => {
      const index = ASCII64_DIGIT.indexOf(char);
      return index >= 0 && index < 64 ? index : 64;
    });
    const startBytes = [...(start || ASCII64_DIGIT[0])].map(char => {
      const index = ASCII64_DIGIT.indexOf(char);
      return index >= 0 && index < 64 ? index : 0;
    });

    for (let i = 0, start = startBytes; i < count; ++i) {
      const result: number[] = [];
      for (
        let j = 0, randBits = 0, equalStartEnd = true, resultEqualStart = true;
        (
          resultEqualStart ||                         // ensure result is not the same as start
          Math.round(randBits) < this.minRandBits ||  // ensure enough randomness
          result[result.length - 1] === 0             // ensure insert between (start, result) is possible
        );
        ++j
      ) {
        const rangeStart = start[j] ?? 0;
        const rangeEnd: number = equalStartEnd ? (endBytes[j] ?? 64) : 64;
        equalStartEnd = equalStartEnd && rangeStart === rangeEnd;
        const next = equalStartEnd ? rangeStart : Math.floor(this.rand() * (rangeEnd - rangeStart) + rangeStart);
        result.push(next);
        resultEqualStart = resultEqualStart && next === rangeStart;
        if (!equalStartEnd) {
          randBits += Math.log2(rangeEnd - rangeStart);
        }
      }
      yield fractionalIndexToString(result);
      start = result;
    }
  }

  public validate(index: string): boolean {
    for (const char of index) {
      if (ASCII64_DIGIT.indexOf(char) < 0) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Converts a fractional index array to string.
 * @internal
 */
export function fractionalIndexToString(index: number[]): string {
  return index.map(byte => ASCII64_DIGIT[byte] || ASCII64_DIGIT[0]).join('');
}
