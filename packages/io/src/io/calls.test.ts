import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CALL_MASK,
  TYPE_MASK,
  CALL_SHIFT,
  STDIN,
  STDOUT,
  STDERR,
  FILE,
  SOCKET_TCP,
  SOCKET_UDP,
  HTTP,
  INPUT_STREAM_READ,
  INPUT_STREAM_BLOCKING_READ,
  INPUT_STREAM_SUBSCRIBE,
  INPUT_STREAM_DISPOSE,
  OUTPUT_STREAM_CHECK_WRITE,
  OUTPUT_STREAM_WRITE,
  OUTPUT_STREAM_BLOCKING_WRITE,
  OUTPUT_STREAM_FLUSH,
  OUTPUT_STREAM_BLOCKING_FLUSH,
  OUTPUT_STREAM_DISPOSE,
  FS_OPEN,
  FS_CLOSE,
  FS_READ,
  FS_WRITE,
  FS_STAT,
  FS_READDIR,
  FS_MKDIR,
  FS_UNLINK,
  FS_RMDIR,
  FS_RENAME,
  FS_SYMLINK,
  FS_READLINK,
  FS_CHMOD,
  FS_UTIMES,
  FS_TRUNCATE,
  FS_LINK,
  FS_REALPATH,
  HTTP_SEND,
  HTTP_INCOMING,
  SOCKET_CREATE,
  SOCKET_BIND,
  SOCKET_CONNECT,
  SOCKET_LISTEN,
  SOCKET_ACCEPT,
  SOCKET_SEND,
  SOCKET_RECV,
  SOCKET_CLOSE,
  SOCKET_RESOLVE,
  POLL_READY,
  POLL_BLOCK,
  POLL_LIST,
  POLL_DISPOSE,
} from './calls.ts';

describe('call dispatch constants', () => {
  describe('CALL_MASK extracts method correctly', () => {
    it('INPUT_STREAM_READ | FILE masked with CALL_MASK equals INPUT_STREAM_READ', () => {
      const combined = INPUT_STREAM_READ | FILE;
      assert.strictEqual(combined & CALL_MASK, INPUT_STREAM_READ);
    });

    it('FS_OPEN | STDIN masked with CALL_MASK equals FS_OPEN', () => {
      const combined = FS_OPEN | STDIN;
      assert.strictEqual(combined & CALL_MASK, FS_OPEN);
    });

    it('POLL_READY | HTTP masked with CALL_MASK equals POLL_READY', () => {
      const combined = POLL_READY | HTTP;
      assert.strictEqual(combined & CALL_MASK, POLL_READY);
    });
  });

  describe('TYPE_MASK extracts type correctly', () => {
    it('INPUT_STREAM_READ | FILE masked with TYPE_MASK equals FILE', () => {
      const combined = INPUT_STREAM_READ | FILE;
      assert.strictEqual(combined & TYPE_MASK, FILE);
    });

    it('OUTPUT_STREAM_WRITE | SOCKET_TCP masked with TYPE_MASK equals SOCKET_TCP', () => {
      const combined = OUTPUT_STREAM_WRITE | SOCKET_TCP;
      assert.strictEqual(combined & TYPE_MASK, SOCKET_TCP);
    });

    it('POLL_READY | HTTP masked with TYPE_MASK equals HTTP', () => {
      const combined = POLL_READY | HTTP;
      assert.strictEqual(combined & TYPE_MASK, HTTP);
    });
  });

  describe('all method constants have upper 8 bits only (no overlap with type bits)', () => {
    const methods = [
      INPUT_STREAM_READ,
      INPUT_STREAM_BLOCKING_READ,
      INPUT_STREAM_SUBSCRIBE,
      INPUT_STREAM_DISPOSE,
      OUTPUT_STREAM_CHECK_WRITE,
      OUTPUT_STREAM_WRITE,
      OUTPUT_STREAM_BLOCKING_WRITE,
      OUTPUT_STREAM_FLUSH,
      OUTPUT_STREAM_BLOCKING_FLUSH,
      OUTPUT_STREAM_DISPOSE,
      FS_OPEN,
      FS_CLOSE,
      FS_READ,
      FS_WRITE,
      FS_STAT,
      FS_READDIR,
      FS_MKDIR,
      FS_UNLINK,
      FS_RMDIR,
      FS_RENAME,
      FS_SYMLINK,
      FS_READLINK,
      FS_CHMOD,
      FS_UTIMES,
      FS_TRUNCATE,
      FS_LINK,
      FS_REALPATH,
      HTTP_SEND,
      HTTP_INCOMING,
      SOCKET_CREATE,
      SOCKET_BIND,
      SOCKET_CONNECT,
      SOCKET_LISTEN,
      SOCKET_ACCEPT,
      SOCKET_SEND,
      SOCKET_RECV,
      SOCKET_CLOSE,
      SOCKET_RESOLVE,
      POLL_READY,
      POLL_BLOCK,
      POLL_LIST,
      POLL_DISPOSE,
    ];

    it('no method constant has lower 24 bits set', () => {
      for (const method of methods) {
        assert.strictEqual(
          method & TYPE_MASK,
          0,
          `Method 0x${method.toString(16)} has lower bits set`
        );
      }
    });
  });

  describe('all type constants have lower 24 bits only (no overlap with method bits)', () => {
    const types = [STDIN, STDOUT, STDERR, FILE, SOCKET_TCP, SOCKET_UDP, HTTP];

    it('no type constant has upper 8 bits set', () => {
      for (const type of types) {
        assert.strictEqual(
          type & CALL_MASK,
          0,
          `Type 0x${type.toString(16)} has upper bits set`
        );
      }
    });
  });

  describe('verify specific values', () => {
    it('STDIN equals 1', () => {
      assert.strictEqual(STDIN, 1);
    });

    it('FILE equals 4', () => {
      assert.strictEqual(FILE, 4);
    });

    it('FS_OPEN equals 20 << 24', () => {
      assert.strictEqual(FS_OPEN, 20 << 24);
    });

    it('POLL_READY equals 60 << 24', () => {
      assert.strictEqual(POLL_READY, 60 << 24);
    });

    it('CALL_MASK equals 0xff000000', () => {
      assert.strictEqual(CALL_MASK, 0xff000000);
    });

    it('TYPE_MASK equals 0x00ffffff', () => {
      assert.strictEqual(TYPE_MASK, 0x00ffffff);
    });

    it('CALL_SHIFT equals 24', () => {
      assert.strictEqual(CALL_SHIFT, 24);
    });
  });
});
