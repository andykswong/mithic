/** Lexicographically compares 2 ArrayLike of primitives in constant time. */
export function arrayCompare<T extends string | number | boolean | bigint>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const length = Math.min(a.length, b.length);
  let result = 0;
  for (let i = 0; i < length; ++i) {
    const diff = (a[i] < b[i] ? -1 : 0) + (b[i] < a[i] ? 1 : 0);
    result = result ? result : diff;
  }
  return Math.sign(result ? result : (a.length - b.length));
}
