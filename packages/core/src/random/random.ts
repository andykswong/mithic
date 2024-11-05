import { type HostFunction, symbolCabiLower } from '@mithic/commons';

const MAX_BYTES = 65536;
const BUFFER_U64 = new BigUint64Array(1);

export const getRandomBytes: HostFunction<Uint8Array, [bigint]> = (len: bigint): Uint8Array => {
  const bytes = new Uint8Array(Number(len));
  randomFill(bytes);
  return bytes;
};

getRandomBytes[symbolCabiLower] = ({ memory, realloc }) => {
  let buf32 = new Uint32Array(memory.buffer);
  return function getRandomBytes(bigLen: bigint, retptr: number): void {
    const len = Number(bigLen);
    const ptr = realloc(0, 0, 1, len);
    const bytes = new Uint8Array(memory.buffer, ptr, len);
    randomFill(bytes);
    if (memory.buffer !== buf32.buffer) {
      buf32 = new Uint32Array(memory.buffer);
    }
    buf32[retptr >> 2] = ptr;
    buf32[(retptr >> 2) + 1] = len;
  };
};

export function getRandomU64(): bigint {
  return crypto.getRandomValues(BUFFER_U64)[0];
}

function randomFill(bytes: Uint8Array): void {
  const len = bytes.length;
  if (len <= MAX_BYTES) {
    crypto.getRandomValues(bytes);
    return;
  }
  for (let i = 0; i < len; i += MAX_BYTES) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(len, i + MAX_BYTES)));
  }
}
