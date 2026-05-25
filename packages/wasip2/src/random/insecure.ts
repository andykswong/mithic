/** Return `len` insecure pseudo-random bytes. */
export function getInsecureRandomBytes(len: bigint): Uint8Array {
  const bytes = new Uint8Array(Number(len));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (Math.random() * 256) | 0;
  }
  return bytes;
}

/** Return an insecure pseudo-random u64 value. */
export function getInsecureRandomU64(): bigint {
  const hi = BigInt((Math.random() * 0xFFFFFFFF) >>> 0);
  const lo = BigInt((Math.random() * 0xFFFFFFFF) >>> 0);
  return (hi << 32n) | lo;
}
