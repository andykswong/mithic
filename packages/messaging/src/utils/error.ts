import { MessagingError, MessagingErrorType, type MessagingErrorPayload } from '../types.ts';

const ABORT_ERROR_NAME = 'AbortError';

/** @throws {@link MessagingError} with {@link MessagingErrorType.Unsupported} tag. */
export function unsupported(): never {
  throw new MessagingError({ tag: MessagingErrorType.Unsupported });
}

/** Returns {@link MessagingErrorPayload} from error object. */
export function getErrorPayload(e: unknown): MessagingErrorPayload {
  return ((e as Error)?.name === ABORT_ERROR_NAME) ? { tag: MessagingErrorType.Timeout } :
    (e instanceof MessagingError && e.payload) || { tag: MessagingErrorType.Other, val: `internal error: ${e}` };
}
