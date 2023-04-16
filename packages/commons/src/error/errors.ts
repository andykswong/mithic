import { ErrorCode, ErrorName } from './enums.js';
import { CodedError } from './error.js';

/** Creates an AbortError. */
export function abortError<T = unknown, E = unknown>(reason: string = ErrorName.Abort, cause?: E): CodedError<T, E> {
  return new CodedError(reason, {
    name: ErrorName.Abort,
    code: ErrorCode.Abort,
    cause,
  });
}

/** Creates a NotFoundError. */
export function notFoundError<T, E>(
  reason: string = ErrorName.NotFound, detail?: T, cause?: E
): CodedError<T, E> {
  return new CodedError(reason, {
    name: ErrorName.NotFound,
    code: ErrorCode.NotFound,
    detail,
    cause,
  });
}

/** Creates an InvalidStateError. */
export function invalidStateError<T, E>(
  reason: string = ErrorName.InvalidState, code: string = ErrorCode.InvalidState, detail?: T, cause?: E
): CodedError<T, E> {
  return new CodedError(reason, {
    name: ErrorName.InvalidState,
    code,
    detail,
    cause,
  });
}

/** Creates an OperationError. */
export function operationError<T, E>(
  reason: string = ErrorName.OpFailed, code: string = ErrorCode.OpFailed, detail?: T, cause?: E
): CodedError<T, E> {
  return new CodedError(reason, {
    name: ErrorName.OpFailed,
    code,
    detail,
    cause,
  });
}
