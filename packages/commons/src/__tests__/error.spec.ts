import { describe, expect, it } from '@jest/globals';
import { Error } from '../error.ts';

describe(Error.name, () => {
  it('should initialize with given options', () => {
    const cause = new globalThis.Error('Error cause');
    const error = new Error('Error message', {
      name: 'TestError',
      code: 'ABORT_ERR',
      payload: { 'this': 'is a testing' },
      cause
    });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});
