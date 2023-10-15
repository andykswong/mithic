import {
  ABORT_ERR, ERR_OPERATION_FAILED, INVALID_STATE_ERR, NOT_FOUND_ERR, NOT_SUPPORTED_ERR, TIMEOUT_ERR
} from './code.js';
import { CodedError, ErrorCodeDetailOptions, ErrorDetailOptions } from './error.js';

/** An AbortError. */
export class AbortError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = AbortError.name,
    options?: ErrorDetailOptions<T>,
  ) {
    super(message, { name: AbortError.name, code: ABORT_ERR, ...options });
  }
}

/** A TimeoutError. */
export class TimeoutError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = TimeoutError.name,
    options?: ErrorDetailOptions<T>,
  ) {
    super(message, { name: TimeoutError.name, code: TIMEOUT_ERR, ...options });
  }
}

/** A NotFoundError. */
export class NotFoundError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = NotFoundError.name,
    options?: ErrorDetailOptions<T>,
  ) {
    super(message, { name: NotFoundError.name, code: NOT_FOUND_ERR, ...options });
  }
}

/** A NotSupportedError. */
export class NotSupportedError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = NotSupportedError.name,
    options?: ErrorDetailOptions<T>,
  ) {
    super(message, { name: NotSupportedError.name, code: NOT_SUPPORTED_ERR, ...options });
  }
}

/** An InvalidStateError. */
export class InvalidStateError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = InvalidStateError.name,
    options?: ErrorDetailOptions<T>,
  ) {
    super(message, { name: InvalidStateError.name, code: INVALID_STATE_ERR, ...options });
  }
}

/** An OperationError. */
export class OperationError<T = unknown, E = unknown> extends CodedError<T, E> {
  public constructor(
    message = InvalidStateError.name,
    options?: ErrorCodeDetailOptions<T>,
  ) {
    super(message, { name: OperationError.name, code: ERR_OPERATION_FAILED, ...options });
  }
}
