import { symbolCabiLower, type HostFunction } from '@mithic/commons';

export const resolution: HostFunction<{ seconds: bigint, nanoseconds: number }, []> = () => {
  return { seconds: 0n, nanoseconds: 1e6 };
};

resolution[symbolCabiLower] = ({ memory }) => {
  let buf32 = new Uint32Array(memory.buffer);
  return function resolution(retptr) {
    if (memory.buffer !== buf32.buffer) {
      buf32 = new Uint32Array(memory.buffer);
    }
    buf32[(retptr >> 2) + 0] = 0;
    buf32[(retptr >> 2) + 1] = 0;
    buf32[(retptr >> 2) + 2] = 1e6;
  };
};

export const now: HostFunction<{ seconds: bigint, nanoseconds: number }, []> = () => {
  const now = Date.now();
  const seconds = BigInt(Math.floor(now / 1e3));
  const nanoseconds = (now % 1e3) * 1e6;
  return { seconds, nanoseconds };
};

now[symbolCabiLower] = ({ memory }) => {
  let buf32 = new Uint32Array(memory.buffer);
  let buf64 = new BigUint64Array(memory.buffer);
  return function now(retptr) {
    if (memory.buffer !== buf32.buffer) {
      buf32 = new Uint32Array(memory.buffer);
      buf64 = new BigUint64Array(memory.buffer);
    }
    const now = Date.now();
    buf64[(retptr >> 3) + 0] = BigInt(Math.floor(now / 1e3));
    buf32[(retptr >> 2) + 2] = (now % 1e3) * 1e6;
  };
};
