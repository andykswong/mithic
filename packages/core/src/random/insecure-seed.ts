import { symbolCabiLower, type HostFunction } from '@mithic/commons';
import { getRandomU64 } from './random.ts';

export const insecureSeed: HostFunction<[bigint, bigint], []> = () => {
  return [getRandomU64(), getRandomU64()];
};

insecureSeed[symbolCabiLower] = ({ memory }) => {
  let buf64 = new BigUint64Array(memory.buffer);
  return function randomBytes(retptr: number): void {
    if (memory.buffer !== buf64.buffer) {
      buf64 = new BigUint64Array(memory.buffer);
    }
    buf64[retptr >> 3] = getRandomU64();
    buf64[(retptr >> 3) + 1] = getRandomU64();
  };
};
