import { getRandomU64 } from './random.ts';

export function insecureSeed(): [bigint, bigint] {
  return [getRandomU64(), getRandomU64()];
}
