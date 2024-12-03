import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { WebStreamStdioProvider } from './index.ts';

describe('WebStreamStdioProvider', () => {
  let provider: WebStreamStdioProvider;
  let stdinBuffer: Uint8Array[];
  let stdoutBuffer: Uint8Array[];
  let stderrBuffer: Uint8Array[];

  beforeEach(() => {
    stdinBuffer = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    stdoutBuffer = [];
    stderrBuffer = [];
    mock.getter(process, 'stdin', () => new Readable({
      read() {
        for (const chunk of stdinBuffer) {
          this.push(chunk);
        }
        this.push(null);
      }
    }));
    mock.getter(process, 'stdout', () => new Writable({
      write(chunk, _, callback) {
        stdoutBuffer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        callback();
      }
    }));
    mock.getter(process, 'stderr', () => new Writable({
      write(chunk, _, callback) {
        stderrBuffer.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        callback();
      }
    }));
    provider = new WebStreamStdioProvider();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getStdin', () => {
    it('should return a ReadStream instance from stdin', async () => {
      const stream = provider.getStdin();
      await stream.poll();
      assert.strictEqual(stream.checkRead(), stdinBuffer[0].length);
      assert.deepStrictEqual(stream.read(5), stdinBuffer[0]);
    });
  });

  describe('getStdout', () => {
    it('should return a WriteStream instance from stdout', async () => {
      const stream = provider.getStdout();
      assert.ok(stream.checkWrite() > 0);
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      assert.ok(await stream.flush());
      assert.deepStrictEqual(stdoutBuffer, [data]);
    });
  });

  describe('getStderr', () => {
    it('should return a WriteStream instance from stderr', async () => {
      const stream = provider.getStderr();
      assert.ok(stream.checkWrite() > 0);
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      assert.ok(await stream.flush());
      assert.deepStrictEqual(stderrBuffer, [data]);
    });
  });
});
