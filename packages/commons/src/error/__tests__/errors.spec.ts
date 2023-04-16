import { ErrorCode } from '../enums.js';
import { abortError, invalidStateError, notFoundError, operationError } from '../errors.js';

describe(abortError.name, () => {
  it ('should initialize with given reason', () => {
    const cause = new Error('of cause');
    const error = abortError('test reason', cause);

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(notFoundError.name, () => {
  it ('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = notFoundError('test reason', detail, cause);

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(invalidStateError.name, () => {
  it ('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = invalidStateError('test reason', ErrorCode.Error, detail, cause);

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(operationError.name, () => {
  it ('should initialize with given parameters', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = operationError('test reason', ErrorCode.InvalidArg, detail, cause);

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});
