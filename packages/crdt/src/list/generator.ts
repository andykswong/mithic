/** Generator of ordered string indices. */
export interface IndexGenerator<T = string> {
  /** Generates `count` indices between `start` and `end` exclusively. */
  create(start?: T, end?: T, count?: number): Iterable<T>;

  /** Returns if given index is valid for this generator. */
  validate(index: T): boolean;
}
