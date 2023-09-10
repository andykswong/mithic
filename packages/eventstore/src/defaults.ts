import { ContentId } from '@mithic/commons';
import { base64 } from 'multiformats/bases/base64';

/** Default page size for batch operations. */
export const DEFAULT_BATCH_SIZE = 64;

/** Default key encoder function. */
export const DEFAULT_KEY_ENCODER = <K>(key: K) => (key as ContentId).toString(base64);

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
