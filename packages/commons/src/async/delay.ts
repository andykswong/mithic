/** Wait for a certain amount of time in millseconds. This wraps `setTimeout` as a Promise and can be aborted. */
export function delay(timeMs = 0, options?: { signal?: AbortSignal; }): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, timeMs);
    options?.signal?.addEventListener('abort', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(options?.signal?.reason);
      }
    }, { once: true });
  });
}

const setNextTick: (callback: () => void) => unknown =
  globalThis.requestAnimationFrame ?? globalThis.setImmediate ?? ((resolve) => setTimeout(resolve));

/** Wait for the next tick. This wraps `requestAnimationFrame`, `setImmediate`, or `setTimeout` as a Promise. */
export function immediate(): Promise<void> {
  return new Promise(setNextTick);
}
