import { MessagingError, MessagingErrorType, type MessagingErrorPayload } from '../types.ts';

const ABORT_ERROR_NAME = 'AbortError';

/** @throws {@link MessagingError} with unsupported tag. */
export function unsupported(): never {
  throw new MessagingError({ tag: MessagingErrorType.Other, val: 'unsupported' });
}

/** @throws {@link MessagingError} with invalid request message tag. */
export function invalidRequest(): never {
  throw new MessagingError({ tag: MessagingErrorType.Other, val: 'invalid request message' });
}

/** Returns {@link MessagingErrorPayload} from error object. */
export function getErrorPayload(e: unknown): MessagingErrorPayload {
  return ((e as Error)?.name === ABORT_ERROR_NAME) ? { tag: MessagingErrorType.Timeout } :
    (e instanceof MessagingError && e.payload) || { tag: MessagingErrorType.Other, val: `internal error: ${e}` };
}
