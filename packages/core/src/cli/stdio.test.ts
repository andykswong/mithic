import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { streams, type ReadStream, type WriteStream } from '../io/index.ts';
import { stdin, stdout, stderr, Cli, type StdioProvider } from './index.ts';

describe('stdio', () => {
  let provider: ReturnType<typeof createMockStdioProvider>;

  beforeEach(() => {
    Cli.stdio = provider = createMockStdioProvider();
  });

  describe('getStdin', () => {
    it('should return an InputStream instance from opening /dev/stdin', () => {
      const mockStream = createMockReadStream();
      provider.getStdin.mock.mockImplementation(() => mockStream);
      const stream = stdin.getStdin();
      assert.ok(stream instanceof streams.InputStream);
      assert.strictEqual(stream['stream'], mockStream);
      assert.strictEqual(provider.getStdin.mock.callCount(), 1);
    });
  });

  describe('getStdout', () => {
    it('should return an OutputStream instance from opening /dev/stdout', () => {
      const mockStream = createMockWriteStream();
      provider.getStdout.mock.mockImplementation(() => mockStream);
      const stream = stdout.getStdout();
      assert.ok(stream instanceof streams.OutputStream);
      assert.strictEqual(stream['stream'], mockStream);
      assert.strictEqual(provider.getStdout.mock.callCount(), 1);
    });
  });

  describe('getStderr', () => {
    it('should return an OutputStream instance from opening /dev/stderr', () => {
      const mockStream = createMockWriteStream();
      provider.getStderr.mock.mockImplementation(() => mockStream);
      const stream = stderr.getStderr();
      assert.ok(stream instanceof streams.OutputStream);
      assert.strictEqual(stream['stream'], mockStream);
      assert.strictEqual(provider.getStderr.mock.callCount(), 1);
    });
  });
});

function createMockStdioProvider() {
  return {
    getStdin: mock.fn(),
    getStdout: mock.fn(),
    getStderr: mock.fn(),
  } satisfies StdioProvider;
}

function createMockReadStream() {
  return {
    read: mock.fn(),
    checkRead: mock.fn(),
    poll: mock.fn(),
  } satisfies ReadStream;
}

function createMockWriteStream() {
  return {
    write: mock.fn(),
    checkWrite: mock.fn(),
    flush: mock.fn(),
  } satisfies WriteStream;
}
