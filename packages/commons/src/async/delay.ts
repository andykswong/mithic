/** Wait for a certain amount of time in millseconds. This wraps `setTimeout` as a Promise. */
export function wait(timeMs = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeMs));
}

const setNextTick: (callback: () => void) => unknown =
  globalThis.requestAnimationFrame ?? globalThis.setImmediate ?? ((resolve) => setTimeout(resolve));

/** Wait for the next tick. This wraps `requestAnimationFrame` in browser and `setImmediate` in node as a Promise. */
export function immediate(): Promise<void> {
  return new Promise(setNextTick);
}
