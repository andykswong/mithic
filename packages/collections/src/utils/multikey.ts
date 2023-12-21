import { compareBuffers } from '@mithic/commons';

/** A multi-parts key. */
export type MultiKey<K = string | number | BufferSource> = readonly K[];

/**
 * Multi-key comparator function, similar to IndexedDB key comparison (without support for Date).
 * See: {@link https://www.w3.org/TR/IndexedDB/#compare-two-keys}
 */
export function compareMultiKeys<K>(a: K, b: K): number {
  const typeA = typeof a;
  const typeB = typeof b;
  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);
  const isViewA = ArrayBuffer.isView(a);
  const isViewB = ArrayBuffer.isView(b);

  if (typeA !== typeB || (isArrayA && !isArrayB) || (isViewA && !isViewB)) {
    if (isArrayA) { return 1; }
    if (isArrayB) { return -1; }
    if (isViewA) { return 1; }
    if (isViewB) { return -1; }
    if (typeA === 'string') { return 1; }
    if (typeB === 'string') { return -1; }
    return -1;
  }

  if (isArrayA && isArrayB) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const result = compareMultiKeys(a[i], b[i]);
      if (result !== 0) { return result; }
    }
    return Math.sign(a.length - b.length);
  }

  if (isViewA && isViewB) {
    return compareBuffers(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    );
  }

  return a < b ? -1 : b < a ? 1 : 0;
}
