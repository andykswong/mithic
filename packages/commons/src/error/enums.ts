/** Error names. */
export enum ErrorName {
  Coded = 'CodedError',
  Abort = 'AbortError',
  InvalidState = 'InvalidStateError',
  NotFound = 'NotFoundError',
  OpFailed = 'OperationError',
}

/** Error codes. */
export enum ErrorCode {
  Error = 'ERR',
  Abort = 'ABORT_ERR',
  CryptoInvalidIV = 'ERR_CRYPTO_INVALID_IV',
  CryptoInvalidKey = 'ERR_CRYPTO_INVALID_KEYPAIR',
  CryptoKeyLen = 'ERR_CRYPTO_INVALID_KEYLEN',
  CryptoMsgLen = 'ERR_CRYPTO_INVALID_MESSAGELEN',
  Exist = 'ERR_EXIST',
  InvalidArg = 'ERR_INVALID_ARG_VALUE',
  InvalidState = 'ERR_INVALID_STATE',
  NotFound = 'ERR_NOT_FOUND',
  OpFailed = 'ERR_OPERATION_FAILED',
  UnsupportedOp = 'ERR_UNSUPPORTED_OPERATION',
}
