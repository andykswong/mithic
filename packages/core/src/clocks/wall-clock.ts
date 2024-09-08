export function resolution() {
  return { seconds: 0n, nanoseconds: 1e6 };
}

export function now() {
  const now = Date.now();
  const seconds = BigInt(Math.floor(now / 1e3));
  const nanoseconds = (now % 1e3) * 1e6;
  return { seconds, nanoseconds };
}
