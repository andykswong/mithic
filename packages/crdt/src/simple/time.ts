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
