import { describe, expect, it, jest } from '@jest/globals';
import { exit } from '../exit.ts';

describe('exit', () => {
  let exitSpy: jest.SpiedFunction<() => void>;
  let closeSpy: jest.SpiedFunction<() => void>;

  beforeEach(() => {
    exitSpy = jest.spyOn(globalThis.process, 'exit');
    exitSpy.mockImplementation(() => {});
    globalThis.close = () => {};
    closeSpy = jest.spyOn(globalThis, 'close');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  })

  it('should call process.exit with correct status code', () => {
    exitSpy.mockImplementation(() => { throw new Error('exit'); });
    expect(() => exit({ tag: 'ok', val: undefined })).toThrowError('exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(() => exit({ tag: 'err', val: undefined })).toThrowError('exit');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('should call close as fallback', () => {
    exit({ tag: 'ok', val: undefined });
    expect(closeSpy).toHaveBeenCalled();
  });
});
