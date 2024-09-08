import { Error } from '@mithic/commons';

/** Error which may be raised by functions in this package. */
export class StoreError extends Error<StoreErrorPayload, StoreErrorType> {
  public constructor(payload: StoreErrorPayload) {
    const msg = payload.tag === StoreErrorType.Other ? payload.val : payload.tag;
    super(msg, { name: StoreError.name, payload });
  }
}

/** The set of error types which may be raised by functions in this package. */
export const StoreErrorType = {
  /** The host does not recognize the store identifier requested. */
  NoSuchStore: 'no-such-store',
  /** The requesting component does not have access to the specified store. */
  AccessDenied: 'access-denied',
  /** The request or operation timed out. */
  Timeout: 'timeout',
  /** Some implementation-specific error has occurred (e.g. I/O). */
  Other: 'other'
} as const;

export type StoreErrorType = typeof StoreErrorType[keyof typeof StoreErrorType];

/** Error which may be raised by functions in this package. */
export type StoreErrorPayload = {
  tag: typeof StoreErrorType.NoSuchStore | typeof StoreErrorType.AccessDenied | typeof StoreErrorType.Timeout,
  val?: undefined,
} | {
  tag: typeof StoreErrorType.Other,
  val: string,
};

/** A response to a listKeys operation. */
export interface KeyResponse {
  /** The list of keys returned by the query. */
  readonly keys: string[],
  /** The continuation token to use to fetch the next page of keys. */
  readonly cursor?: string,
}

/** A response to a listKeys operation. */
export interface KeySelector {
  /** Start of the range (inclusive). */
  readonly start?: string;
  /** End of the range (exclusive). */
  readonly end?: string;
  /** The sort order of the keys. */
  readonly order?: KeyOrder;
}

/** The sort order for listKeys operation. */
export const KeyOrder = {
  /** Ascending order. */
  Asc: 'asc',
  /** Descending order. */
  Desc: 'desc',
} as const;

export type KeyOrder = typeof KeyOrder[keyof typeof KeyOrder];
