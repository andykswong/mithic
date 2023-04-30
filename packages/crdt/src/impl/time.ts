/** Creates a hybrid timestamp generator. */
export function hybridTime(now: () => number = Date.now): () => number {
  let last = now();
  return () => {
    const nextTime = now();
    last = nextTime > last ? nextTime : last + 1;
    return last;
  }
}
