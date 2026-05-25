import { Pollable } from '../io/poll.ts';

/** Query the resolution of the clock in nanoseconds. */
export function resolution(): bigint {
  // see: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now#security_requirements
  return globalThis.crossOriginIsolated === true ? 5000n : 100_000n;
}

/** Read the current value of the clock in nanoseconds. */
export function now(): bigint {
  return BigInt(Math.floor(nowMs() * 1e6));
}

/** Create a Pollable which will resolve once the specified instant in nanoseconds has occurred. */
export function subscribeInstant(when: bigint): Pollable {
  const whenMs = Number(when / 1000n) / 1000;
  return new Pollable(() => nowMs() >= whenMs);
}

/** Create a Pollable which will resolve after the specified duration in nanoseconds has elapsed. */
export function subscribeDuration(duration: bigint): Pollable {
  return subscribeInstant(now() + duration);
}

function nowMs(): number {
  return performance.now();
}
