import { describe, expect, it } from '@jest/globals';
import { ErrorCode } from '../enums.js';
import { CodedError } from '../error.js';

describe(CodedError.name, () => {
  it('should initialize with given options', () => {
    const cause = new Error('Error cause');
    const error = new CodedError('Error message', {
      name: 'TestError',
      code: ErrorCode.Abort,
      detail: { 'this': 'is a testing' },
      cause
    });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});
