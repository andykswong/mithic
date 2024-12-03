import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { type IoStreamClientProvider, type SyncReadStream, type SyncWriteStream } from '../../types.ts';
import { SyncStdioProvider } from './index.ts';

describe('SyncStdioProvider', () => {
  let client: IoStreamClientProvider;
  let provider: SyncStdioProvider;

  beforeEach(() => {
    provider = new SyncStdioProvider();
    client = provider['client'];
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getStdin', () => {
    it('should return a ReadStream instance from IoStreamClientProvider', () => {
      const stdinMock = {
        read: mock.fn(),
        checkRead: mock.fn(),
        poll: mock.fn()
      } satisfies SyncReadStream;
      const openReadStreamMock = mock.method(client, 'openReadStream');
      openReadStreamMock.mock.mockImplementationOnce(() => stdinMock);
      const stream = provider.getStdin();
      assert.strictEqual(stream, stdinMock);
      assert.strictEqual(openReadStreamMock.mock.callCount(), 1);
      assert.deepStrictEqual(openReadStreamMock.mock.calls[0].arguments, ['/dev/stdin']);
    });
  });

  describe('getStdout', () => {
    it('should return a WriteStream instance from stdout', () => {
      const stdoutMock = {
        write: mock.fn(),
        checkWrite: mock.fn(),
        flush: mock.fn()
      } satisfies SyncWriteStream;
      const openWriteStreamMock = mock.method(client, 'openWriteStream');
      openWriteStreamMock.mock.mockImplementationOnce(() => stdoutMock);
      const stream = provider.getStdout();
      assert.strictEqual(stream, stdoutMock);
      assert.strictEqual(openWriteStreamMock.mock.callCount(), 1);
      assert.deepStrictEqual(openWriteStreamMock.mock.calls[0].arguments, ['/dev/stdout']);
    });
  });

  describe('getStderr', () => {
    it('should return a WriteStream instance from stderr', () => {
      const stderrMock = {
        write: mock.fn(),
        checkWrite: mock.fn(),
        flush: mock.fn()
      } satisfies SyncWriteStream;
      const openWriteStreamMock = mock.method(client, 'openWriteStream');
      openWriteStreamMock.mock.mockImplementationOnce(() => stderrMock);
      const stream = provider.getStderr();
      assert.strictEqual(stream, stderrMock);
      assert.strictEqual(openWriteStreamMock.mock.callCount(), 1);
      assert.deepStrictEqual(openWriteStreamMock.mock.calls[0].arguments, ['/dev/stderr']);
    });
  });
});
