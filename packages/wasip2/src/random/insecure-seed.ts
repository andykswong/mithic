import { getRandomU64 } from './random.ts';

/**
 * Return a 128-bit value that may contain a pseudo-random value.
 */
export function insecureSeed(): [bigint, bigint] {
  return [getRandomU64(), getRandomU64()!];
}
