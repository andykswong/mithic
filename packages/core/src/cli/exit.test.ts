import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { exit } from './index.ts';

describe('exit', () => {
  let exitSpy: Mock<() => void>;
  let closeSpy: Mock<() => void>;

  beforeEach(() => {
    exitSpy = mock.method(globalThis.process, 'exit');
    exitSpy.mock.mockImplementation(() => {});
    globalThis.close = () => {};
    closeSpy = mock.method(globalThis, 'close');
  });

  afterEach(() => {
    mock.restoreAll();
  })

  it('should call process.exit with correct status code', () => {
    const error = new Error('exit');
    exitSpy.mock.mockImplementation(() => { throw error; });
    assert.throws(() => exit.exit({ tag: 'ok', val: undefined }), error);
    assert.throws(() => exit.exit({ tag: 'err', val: undefined }), error);
    assert.deepStrictEqual(exitSpy.mock.calls[0].arguments, [0]);
    assert.deepStrictEqual(exitSpy.mock.calls[1].arguments, [1]);
  });

  it('should call close as fallback', () => {
    exit.exit({ tag: 'ok', val: undefined });
    assert.strictEqual(closeSpy.mock.callCount(), 1);
  });
});
