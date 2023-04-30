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
  InvalidArg = 'ERR_INVALID_ARG_VALUE',
  InvalidState = 'ERR_INVALID_STATE',
  Exist = 'ERR_EXIST',
  NotFound = 'ERR_NOT_FOUND',
  MissingDep = 'ERR_MISSING_DEPENDENCY',
  OpFailed = 'ERR_OPERATION_FAILED',
  UnsupportedOp = 'ERR_UNSUPPORTED_OPERATION',
  CryptoInvalidIV = 'ERR_CRYPTO_INVALID_IV',
  CryptoInvalidKey = 'ERR_CRYPTO_INVALID_KEYPAIR',
  CryptoKeyLen = 'ERR_CRYPTO_INVALID_KEYLEN',
  CryptoMsgLen = 'ERR_CRYPTO_INVALID_MESSAGELEN',
}
