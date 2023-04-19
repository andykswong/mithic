/**
 * Hybrid clock module.
 * @packageDocumentation
 */

/** A hybrid timestamp newtype, which represents a hybrid of physical and logical timestamp. */
export type Timestamp = number & { readonly HybridTime: unique symbol };

/**
 * Returns the next tick given the latest observed timestamp and current timestamp.
 * If the current time (now) is greater than given timestamp, returns it.
 * Otherwise, returns timestamp + 1, i.e. treating the timestamp as a logical time.
 */
export function tick(latestTime = 0 as Timestamp, now = Date.now() as Timestamp): Timestamp {
  return (now > latestTime ? now : latestTime + 1) as Timestamp;
}
