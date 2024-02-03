import { describe, expect, it } from '@jest/globals';
import { CodedError } from '../error.ts';

describe(CodedError.name, () => {
  it('should initialize with given options', () => {
    const cause = new Error('Error cause');
    const error = new CodedError('Error message', {
      name: 'TestError',
      code: 'ABORT_ERR',
      detail: { 'this': 'is a testing' },
      cause
    });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});
