
/** A matcher of strings. */
export interface StringMatcher {
  [Symbol.match](input: string): string[] | null;
}

export const StringMatcher = {
  /** Matches specific string value exactly. */
  matchExact(value: string): StringMatcher {
    return {
      [Symbol.match](input: string) {
        return input === value ? [value] : null;
      }
    };
  },

  /** Matches string with specific prefix. */
  matchPrefix(prefix: string): StringMatcher {
    return {
      [Symbol.match](input: string) {
        return input.startsWith(prefix) ? [input] : null;
      }
    };
  },

  /** Matches any string. */
  matchAll(): StringMatcher {
    return {
      [Symbol.match](input: string) {
        return [input];
      }
    };
  }
};
