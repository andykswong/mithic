import { describe, expect, it } from '@jest/globals';
import { AbortError, InvalidStateError, NotFoundError, NotSupportedError, OperationError, TimeoutError } from '../errors.ts';

describe(AbortError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new AbortError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(TimeoutError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new TimeoutError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(NotFoundError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new NotFoundError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(NotSupportedError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new NotSupportedError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(InvalidStateError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new InvalidStateError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});

describe(OperationError.name, () => {
  it('should initialize with given reason', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new OperationError('test reason', { detail, cause });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });

  it('should initialize with given reason and code', () => {
    const detail = { 'detail': 'issue' };
    const cause = new Error('of cause');
    const error = new OperationError('test reason', { detail, cause, code: 'TEST_ERR' });

    expect(error).toMatchSnapshot();
    expect({ ...error }).toMatchSnapshot();
    expect(error.cause).toBe(cause);
  });
});
