/** An options interface for an async API, that supports an optional AbortSignal property. */
export interface AbortOptions {
  /** An optional AbortSignal that can be used to abort an async task. */
  signal?: AbortSignal;
}
