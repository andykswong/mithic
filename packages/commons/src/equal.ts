/** Trait with the equals method. */
export interface Equal<T = unknown> {
  /** Returns if this equals RHS. */
  equals(rhs: T): boolean;
}

/** Trait of a stringifiable object with optional equals method. */
export interface StringEquatable extends Partial<Equal<StringEquatable>> {
  toString(): string;
}

/**
 * Returns if 2 objects are either equal via the {@link Equal} trait, or have the same string representations.
 */
export function equalsOrSameString<T extends StringEquatable>(lhs: T, rhs: T): boolean {
  if (lhs === rhs) {
    return true;
  }
  if (lhs.equals) {
    return lhs.equals(rhs);
  }
  return `${lhs}` === `${rhs}`;
}
