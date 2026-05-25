/** A time and date in seconds plus nanoseconds. */
export interface Datetime {
  seconds: bigint;
  nanoseconds: number;
}

/** Query the resolution of the clock. */
export function resolution(): Datetime {
  return { seconds: 0n, nanoseconds: 1_000_000 };
}

/** Read the current value of the clock. */
export function now(): Datetime {
  const ms = Date.now();
  const seconds = BigInt(Math.floor(ms / 1e3));
  const nanoseconds = (ms % 1e3) * 1e6;
  return { seconds, nanoseconds };
}
