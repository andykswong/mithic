const MAX_BYTES = 65536;
const BUFFER_U64 = new BigUint64Array(1);

/** Return `len` cryptographically-secure random or pseudo-random bytes. */
export function getRandomBytes(len: bigint): Uint8Array {
  const bytes = new Uint8Array(Number(len));
  randomFill(bytes);
  return bytes;
}

/** Return a cryptographically-secure random or pseudo-random u64 value. */
export function getRandomU64(): bigint {
  return crypto.getRandomValues(BUFFER_U64)[0];
}

function randomFill(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += MAX_BYTES) {
    crypto.getRandomValues(
      bytes.subarray(i, Math.min(bytes.length, i + MAX_BYTES)) as Uint8Array<ArrayBuffer>
    );
  }
}
