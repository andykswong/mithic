/** Returns the FNV-1a hash of the given string. */
export function fnv1aHash(input: string): number {
  const FNV_OFFSET = 2166136261;
  const FNV_PRIME = 16777619;

  let hash = FNV_OFFSET;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash *= FNV_PRIME;
  }

  return hash >>> 0;
}

/** Creates k different hash functions from 1-2 hash functions. */
export function kHash<T>(hashA: (value: T) => number, hashB: (value: T) => number = hashA) {
  return (value: T, i = 0): number => {
    return hashA(value) + i * hashB(value);
  }
}
