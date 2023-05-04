import { ContentId } from './hash.js';

/** Lexicographically compares 2 Uint8Arrays in constant time. */
export function compareBuffers(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  let result = 0;
  for (let i = 0; i < length; ++i) {
    const diff = a[i] - b[i];
    result = result ? result : diff;
  }
  return Math.sign(result ? result : (a.byteLength - b.byteLength));
}

/** Concatenates a list of Uint8Arrays and returns the result as a new Uint8Array. */
export function concatBuffers(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((byteLength, val) => byteLength + val.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

/** Compares 2 {@link ContentId}s in constant time. */
export function compareContentIds(a: ContentId, b: ContentId): number {
  return compareBuffers(a.bytes, b.bytes);
}
