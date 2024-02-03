import { InvalidStateError } from '@mithic/commons';

/** Default page size for batch operations. */
export const DEFAULT_BATCH_SIZE = 64;

/** Default key encoder function. */
export const DEFAULT_KEY_ENCODER = <K>(key: K) => `${key}`;

/** Default regex for splitting event types. */
export const DEFAULT_EVENT_TYPE_SEPARATOR = /[._#$\-/]+/g;

/** Creates an atomic hybrid timestamp generator. */
export function atomicHybridTime(
  buffer: SharedArrayBuffer = new SharedArrayBuffer(8),
  now: () => number = Date.now
): (refTime?: number) => number {
  const view = new BigInt64Array(buffer);
  let lastTime = Atomics.load(view, 0);

  return (refTime = 0) => {
    let expectedLastTime, nextTime;
    do {
      expectedLastTime = lastTime;
      nextTime = BigInt(Math.max(now(), refTime));
      nextTime = nextTime > expectedLastTime ? nextTime : expectedLastTime + 1n;
      lastTime = Atomics.compareExchange(view, 0, expectedLastTime, nextTime);
    } while (expectedLastTime !== lastTime);
    return Number(lastTime = nextTime);
  }
}

/** Default decodeKey implementation that uses multiformats as optional dependency. */
export const decodeCID = await (async () => {
  try {
    const { CID } = await import('multiformats');
    return <K>(key: string) => CID.parse(key) as unknown as K;
  } catch (_) {
    return () => { throw new InvalidStateError('multiformats not available'); };
  }
})();
