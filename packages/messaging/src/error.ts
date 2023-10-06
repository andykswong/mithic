import { CodedError } from '@mithic/commons';

/** Message validation error. */
export class MessageValidationError<T = unknown, E = unknown> extends CodedError<T, E> {
  constructor(
    message?: string,
    options?: MessageValidationErrorOptions<T>,
  ) {
    super(message, {
      name: MessageValidationError.name,
      ...options,
      code: options?.code ?? MessageValidationErrorCode.Reject,
    });
  }
}

/** Options for initializing a {@link MessageValidationError}. */
export interface MessageValidationErrorOptions<T> extends ErrorOptions {
  /** Error code. */
  code?: MessageValidationErrorCode;

  /** Error details. */
  detail?: T;
}

/** Message validation error code. */
export enum MessageValidationErrorCode {
  /** The message should be ignored. */
  Ignore = 'ignore',

  /** The message is considered invalid, and it should be rejected. */
  Reject = 'reject'
}
