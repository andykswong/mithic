import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Uses global MessageChannel (available in Node.js 15+ and browsers)
import {
  CALL_MASK, CALL_SHIFT, TYPE_MASK,
  STDIN, STDOUT, STDERR, FILE, SOCKET_TCP, SOCKET_UDP, HTTP,
  INPUT_STREAM_READ, INPUT_STREAM_BLOCKING_READ, INPUT_STREAM_SUBSCRIBE, INPUT_STREAM_DISPOSE,
  OUTPUT_STREAM_CHECK_WRITE, OUTPUT_STREAM_WRITE, OUTPUT_STREAM_BLOCKING_WRITE,
  OUTPUT_STREAM_FLUSH, OUTPUT_STREAM_BLOCKING_FLUSH, OUTPUT_STREAM_DISPOSE,
  FS_OPEN, FS_CLOSE, FS_READ, FS_WRITE, FS_STAT, FS_READDIR, FS_MKDIR, FS_UNLINK,
  FS_RMDIR, FS_RENAME, FS_SYMLINK, FS_READLINK, FS_CHMOD, FS_UTIMES, FS_TRUNCATE,
  FS_LINK, FS_REALPATH,
  HTTP_SEND, HTTP_INCOMING,
  SOCKET_CREATE, SOCKET_BIND, SOCKET_CONNECT, SOCKET_LISTEN, SOCKET_ACCEPT,
  SOCKET_SEND, SOCKET_RECV, SOCKET_CLOSE, SOCKET_RESOLVE,
  POLL_READY, POLL_BLOCK, POLL_LIST, POLL_DISPOSE,
} from './calls.ts';
import { handleBlockingCalls, unpack, type CallHandler } from './sync-bridge.ts';

describe('calls', () => {
  describe('masks and shift', () => {
    it('should have correct mask values', () => {
      assert.strictEqual(CALL_MASK, 0xff000000);
      assert.strictEqual(TYPE_MASK, 0x00ffffff);
      assert.strictEqual(CALL_SHIFT, 24);
    });

    it('masks should be complementary', () => {
      assert.strictEqual((CALL_MASK | TYPE_MASK) >>> 0, 0xffffffff);
      assert.strictEqual((CALL_MASK & TYPE_MASK), 0);
    });
  });

  describe('resource types', () => {
    it('should have correct values in lower 24 bits', () => {
      assert.strictEqual(STDIN, 1);
      assert.strictEqual(STDOUT, 2);
      assert.strictEqual(STDERR, 3);
      assert.strictEqual(FILE, 4);
      assert.strictEqual(SOCKET_TCP, 5);
      assert.strictEqual(SOCKET_UDP, 6);
      assert.strictEqual(HTTP, 7);
    });

    it('should be extractable with TYPE_MASK', () => {
      assert.strictEqual(STDIN & TYPE_MASK, STDIN);
      assert.strictEqual(FILE & TYPE_MASK, FILE);
      assert.strictEqual(HTTP & TYPE_MASK, HTTP);
    });
  });

  describe('stream methods', () => {
    it('should have correct shifted values', () => {
      assert.strictEqual(INPUT_STREAM_READ, 1 << 24);
      assert.strictEqual(INPUT_STREAM_BLOCKING_READ, 2 << 24);
      assert.strictEqual(INPUT_STREAM_SUBSCRIBE, 3 << 24);
      assert.strictEqual(INPUT_STREAM_DISPOSE, 4 << 24);
      assert.strictEqual(OUTPUT_STREAM_CHECK_WRITE, 5 << 24);
      assert.strictEqual(OUTPUT_STREAM_WRITE, 6 << 24);
      assert.strictEqual(OUTPUT_STREAM_BLOCKING_WRITE, 7 << 24);
      assert.strictEqual(OUTPUT_STREAM_FLUSH, 8 << 24);
      assert.strictEqual(OUTPUT_STREAM_BLOCKING_FLUSH, 9 << 24);
      assert.strictEqual(OUTPUT_STREAM_DISPOSE, 10 << 24);
    });

    it('should be extractable with CALL_MASK', () => {
      assert.strictEqual(INPUT_STREAM_READ & CALL_MASK, INPUT_STREAM_READ);
      assert.strictEqual(OUTPUT_STREAM_WRITE & CALL_MASK, OUTPUT_STREAM_WRITE);
    });
  });

  describe('filesystem calls', () => {
    it('should have correct shifted values', () => {
      assert.strictEqual(FS_OPEN, 20 << 24);
      assert.strictEqual(FS_CLOSE, 21 << 24);
      assert.strictEqual(FS_READ, 22 << 24);
      assert.strictEqual(FS_WRITE, 23 << 24);
      assert.strictEqual(FS_STAT, 24 << 24);
      assert.strictEqual(FS_READDIR, 25 << 24);
      assert.strictEqual(FS_MKDIR, 26 << 24);
      assert.strictEqual(FS_UNLINK, 27 << 24);
      assert.strictEqual(FS_RMDIR, 28 << 24);
      assert.strictEqual(FS_RENAME, 29 << 24);
      assert.strictEqual(FS_SYMLINK, 30 << 24);
      assert.strictEqual(FS_READLINK, 31 << 24);
      assert.strictEqual(FS_CHMOD, 32 << 24);
      assert.strictEqual(FS_UTIMES, 33 << 24);
      assert.strictEqual(FS_TRUNCATE, 34 << 24);
      assert.strictEqual(FS_LINK, 35 << 24);
      assert.strictEqual(FS_REALPATH, 36 << 24);
    });
  });

  describe('HTTP calls', () => {
    it('should have correct shifted values', () => {
      assert.strictEqual(HTTP_SEND, 40 << 24);
      assert.strictEqual(HTTP_INCOMING, 41 << 24);
    });
  });

  describe('socket calls', () => {
    it('should have correct shifted values', () => {
      assert.strictEqual(SOCKET_CREATE, 45 << 24);
      assert.strictEqual(SOCKET_BIND, 46 << 24);
      assert.strictEqual(SOCKET_CONNECT, 47 << 24);
      assert.strictEqual(SOCKET_LISTEN, 48 << 24);
      assert.strictEqual(SOCKET_ACCEPT, 49 << 24);
      assert.strictEqual(SOCKET_SEND, 50 << 24);
      assert.strictEqual(SOCKET_RECV, 51 << 24);
      assert.strictEqual(SOCKET_CLOSE, 52 << 24);
      assert.strictEqual(SOCKET_RESOLVE, 53 << 24);
    });
  });

  describe('polling calls', () => {
    it('should have correct shifted values', () => {
      assert.strictEqual(POLL_READY, 60 << 24);
      assert.strictEqual(POLL_BLOCK, 61 << 24);
      assert.strictEqual(POLL_LIST, 62 << 24);
      assert.strictEqual(POLL_DISPOSE, 63 << 24);
    });
  });

  describe('call composition', () => {
    it('should correctly compose call + type', () => {
      const composed = INPUT_STREAM_READ | FILE;
      assert.strictEqual((composed & CALL_MASK) >>> 0, INPUT_STREAM_READ >>> 0);
      assert.strictEqual(composed & TYPE_MASK, FILE);
      assert.strictEqual((composed >>> CALL_SHIFT), 1);
    });

    it('should correctly compose filesystem call + type', () => {
      const composed = FS_OPEN | FILE;
      assert.strictEqual((composed & CALL_MASK) >>> 0, FS_OPEN >>> 0);
      assert.strictEqual(composed & TYPE_MASK, FILE);
      assert.strictEqual((composed >>> CALL_SHIFT), 20);
    });

    it('should correctly compose socket call + type', () => {
      const composed = SOCKET_SEND | SOCKET_TCP;
      assert.strictEqual((composed & CALL_MASK) >>> 0, SOCKET_SEND >>> 0);
      assert.strictEqual(composed & TYPE_MASK, SOCKET_TCP);
      assert.strictEqual((composed >>> CALL_SHIFT), 50);
    });
  });
});

describe('sync-bridge', () => {
  const HEADER_SIZE = 12;
  const BUFFER_SIZE = 1024;

  function waitForSignal(signalView: Int32Array): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (Atomics.load(signalView, 0) !== 0) { resolve(); return; }
        setTimeout(check, 1);
      };
      check();
    });
  }

  describe('handleBlockingCalls', () => {
    it('should dispatch calls and write JSON result into SAB', async () => {
      const { port1, port2 } = new MessageChannel();
      const calls: Array<{ call: number; id: number | null; payload: unknown }> = [];

      const handler: CallHandler = async (call, id, payload) => {
        calls.push({ call, id, payload });
        return (payload as number) * 2;
      };

      handleBlockingCalls(handler, port1);

      const sharedBuffer = new SharedArrayBuffer(HEADER_SIZE + BUFFER_SIZE, { maxByteLength: HEADER_SIZE + BUFFER_SIZE * 4 });
      const headerView = new Int32Array(sharedBuffer, 0, 3);
      const dataView = new Uint8Array(sharedBuffer, HEADER_SIZE);
      Atomics.store(headerView, 0, 0);

      port2.postMessage({ sharedBuffer, call: 42, id: null, payload: 7 });
      await waitForSignal(headerView);

      assert.strictEqual(Atomics.load(headerView, 0), 1);
      assert.strictEqual(headerView[1], 1); // TYPE_JSON
      const resultLen = headerView[2]!;
      assert.ok(resultLen > 0);
      const copy = new Uint8Array(resultLen); copy.set(dataView.subarray(0, resultLen));
      const result = unpack(1, copy);
      assert.strictEqual(result, 14);

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], { call: 42, id: null, payload: 7 });

      port1.close();
      port2.close();
    });

    it('should write Uint8Array result as raw bytes', async () => {
      const { port1, port2 } = new MessageChannel();

      const handler: CallHandler = async () => new Uint8Array([65, 66, 67]);

      handleBlockingCalls(handler, port1);

      const sharedBuffer = new SharedArrayBuffer(HEADER_SIZE + BUFFER_SIZE, { maxByteLength: HEADER_SIZE + BUFFER_SIZE * 4 });
      const headerView = new Int32Array(sharedBuffer, 0, 3);
      const dataView = new Uint8Array(sharedBuffer, HEADER_SIZE);
      Atomics.store(headerView, 0, 0);

      port2.postMessage({ sharedBuffer, call: 0, id: null, payload: null });
      await waitForSignal(headerView);

      assert.strictEqual(headerView[1], 2); // TYPE_BYTES
      assert.strictEqual(headerView[2], 3);
      assert.deepStrictEqual(Array.from(dataView.subarray(0, 3)), [65, 66, 67]);

      port1.close();
      port2.close();
    });

    it('should write error into SAB with TYPE_ERROR', async () => {
      const { port1, port2 } = new MessageChannel();

      const handler: CallHandler = async () => {
        throw { message: 'test error' };
      };

      handleBlockingCalls(handler, port1);

      const sharedBuffer = new SharedArrayBuffer(HEADER_SIZE + BUFFER_SIZE, { maxByteLength: HEADER_SIZE + BUFFER_SIZE * 4 });
      const headerView = new Int32Array(sharedBuffer, 0, 3);
      const dataView = new Uint8Array(sharedBuffer, HEADER_SIZE);
      Atomics.store(headerView, 0, 0);

      port2.postMessage({ sharedBuffer, call: 1, id: 5, payload: 'test' });
      await waitForSignal(headerView);

      assert.strictEqual(headerView[1], -1); // TYPE_ERROR
      const resultLen = headerView[2]!;
      assert.ok(resultLen > 0);
      const errCopy = new Uint8Array(resultLen); errCopy.set(dataView.subarray(0, resultLen));
      const error = unpack(1, errCopy) as { message: string };
      assert.strictEqual(error.message, 'test error');

      port1.close();
      port2.close();
    });

    it('should write TYPE_UNDEFINED for undefined result', async () => {
      const { port1, port2 } = new MessageChannel();

      const handler: CallHandler = async () => undefined;

      handleBlockingCalls(handler, port1);

      const sharedBuffer = new SharedArrayBuffer(HEADER_SIZE + BUFFER_SIZE, { maxByteLength: HEADER_SIZE + BUFFER_SIZE * 4 });
      const headerView = new Int32Array(sharedBuffer, 0, 3);
      Atomics.store(headerView, 0, 0);

      port2.postMessage({ sharedBuffer, call: 0, id: null, payload: null });
      await waitForSignal(headerView);

      assert.strictEqual(headerView[1], 0); // TYPE_UNDEFINED
      assert.strictEqual(headerView[2], 0);

      port1.close();
      port2.close();
    });

    it('should handle multiple sequential calls', async () => {
      const { port1, port2 } = new MessageChannel();
      let callCount = 0;

      const handler: CallHandler = async (_call, _id, payload) => {
        callCount++;
        return `result-${payload}`;
      };

      handleBlockingCalls(handler, port1);

      for (let i = 0; i < 3; i++) {
        const sharedBuffer = new SharedArrayBuffer(HEADER_SIZE + BUFFER_SIZE, { maxByteLength: HEADER_SIZE + BUFFER_SIZE * 4 });
        const headerView = new Int32Array(sharedBuffer, 0, 3);
        const dataView = new Uint8Array(sharedBuffer, HEADER_SIZE);
        Atomics.store(headerView, 0, 0);

        port2.postMessage({ sharedBuffer, call: i, id: null, payload: i });
        await waitForSignal(headerView);

        assert.strictEqual(headerView[1], 1); // TYPE_JSON
        const resultLen = headerView[2]!;
        const copy = new Uint8Array(resultLen); copy.set(dataView.subarray(0, resultLen));
        const result = unpack(1, copy);
        assert.strictEqual(result, `result-${i}`);
      }

      assert.strictEqual(callCount, 3);

      port1.close();
      port2.close();
    });
  });
});
