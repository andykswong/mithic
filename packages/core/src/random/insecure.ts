import { getRandomBytes, getRandomU64 } from './random.ts';

export function getInsecureRandomBytes(len: bigint): Uint8Array {
  return getRandomBytes(len);
}

export function getInsecureRandomU64(): bigint {
  return getRandomU64();
}
