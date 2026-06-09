import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { DeviceFsProvider } from './device.ts';
import { FileSystemError } from '../provider.ts';
import type { SyncOutputStreamHandler } from '../../io/streams.ts';

describe('DeviceFsProvider', () => {
  let dev: DeviceFsProvider;
  let stdoutBuffer: Uint8Array[];

  beforeEach(() => {
    stdoutBuffer = [];
    const stdoutHandler: SyncOutputStreamHandler = {
      write(data: Uint8Array) { stdoutBuffer.push(data); },
    };
    const stderrHandler: SyncOutputStreamHandler = {
      write() {},
    };
    dev = new DeviceFsProvider({
      stdout: stdoutHandler,
      stderr: stderrHandler,
    });
  });

  describe('/dev/null', () => {
    it('should return empty on read', () => {
      const handle = dev.open('/null', { read: true });
      const data = dev.read(handle, 0, 1024);
      assert.strictEqual(data.length, 0);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/null', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2, 3]), 0);
      assert.strictEqual(written, 3);
      dev.close(handle);
    });
  });

  describe('/dev/zero', () => {
    it('should return zeroed bytes of requested length', () => {
      const handle = dev.open('/zero', { read: true });
      const data = dev.read(handle, 0, 16);
      assert.strictEqual(data.length, 16);
      assert(data.every(b => b === 0));
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/zero', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2]), 0);
      assert.strictEqual(written, 2);
      dev.close(handle);
    });
  });

  describe('/dev/stdout', () => {
    it('should delegate write to handler', () => {
      const handle = dev.open('/stdout', { write: true });
      const payload = new TextEncoder().encode('hello stdout');
      dev.write(handle, payload, 0);
      assert.strictEqual(stdoutBuffer.length, 1);
      assert.deepStrictEqual(stdoutBuffer[0], payload);
      dev.close(handle);
    });
  });

  describe('/dev/stdin', () => {
    it('should read from stdin handler', () => {
      const input = new TextEncoder().encode('hello');
      const devWithStdin = new DeviceFsProvider({
        stdin: { read: () => undefined, blockingRead: () => input },
      });
      const handle = devWithStdin.open('/stdin', { read: true });
      const data = devWithStdin.read(handle, 0, 1024);
      assert.deepStrictEqual(data, input);
      devWithStdin.close(handle);
    });

    it('should throw on write', () => {
      const handle = dev.open('/stdin', { write: true });
      assert.throws(
        () => dev.write(handle, new Uint8Array([1]), 0),
        (err: unknown) => err instanceof FileSystemError && err.code === 'not-permitted',
      );
      dev.close(handle);
    });
  });

  describe('/dev/random', () => {
    it('should return requested number of bytes on read', () => {
      const handle = dev.open('/random', { read: true });
      const data = dev.read(handle, 0, 32);
      assert.strictEqual(data.length, 32);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/random', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2, 3, 4]), 0);
      assert.strictEqual(written, 4);
      dev.close(handle);
    });

    it('should produce different output on consecutive reads', () => {
      const handle = dev.open('/random', { read: true });
      const a = dev.read(handle, 0, 32);
      const b = dev.read(handle, 0, 32);
      const same = a.every((v, i) => v === b[i]);
      assert.strictEqual(same, false, 'consecutive reads should differ');
      dev.close(handle);
    });
  });

  describe('/dev/urandom', () => {
    it('should return requested number of bytes on read', () => {
      const handle = dev.open('/urandom', { read: true });
      const data = dev.read(handle, 0, 64);
      assert.strictEqual(data.length, 64);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/urandom', { write: true });
      const written = dev.write(handle, new Uint8Array([5, 6]), 0);
      assert.strictEqual(written, 2);
      dev.close(handle);
    });

    it('should produce different output on consecutive reads', () => {
      const handle = dev.open('/urandom', { read: true });
      const a = dev.read(handle, 0, 32);
      const b = dev.read(handle, 0, 32);
      const same = a.every((v, i) => v === b[i]);
      assert.strictEqual(same, false, 'consecutive reads should differ');
      dev.close(handle);
    });
  });

  describe('stat', () => {
    it('should return character-device type for devices', () => {
      const stat = dev.stat('/null');
      assert.strictEqual(stat.type, 'character-device');
      assert.strictEqual(stat.mode, 0o666);
    });

    it('should return directory type for root', () => {
      const stat = dev.stat('/');
      assert.strictEqual(stat.type, 'directory');
    });

    it('should throw no-entry for unknown device', () => {
      assert.throws(
        () => dev.stat('/unknown'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'no-entry',
      );
    });
  });

  describe('readdir', () => {
    it('should return device names', () => {
      const entries = dev.readdir('/');
      const names = entries.map(e => e.name);
      assert(names.includes('null'));
      assert(names.includes('zero'));
      assert(names.includes('random'));
      assert(names.includes('urandom'));
      assert(names.includes('stdin'));
      assert(names.includes('stdout'));
      assert(names.includes('stderr'));
      assert.strictEqual(entries.length, 7);
    });
  });

  describe('permission-denied operations', () => {
    it('should throw not-permitted on mkdir', () => {
      assert.throws(
        () => dev.mkdir('/newdir'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'not-permitted',
      );
    });

    it('should throw not-permitted on unlink', () => {
      assert.throws(
        () => dev.unlink('/null'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'not-permitted',
      );
    });

    it('should throw not-permitted on rmdir', () => {
      assert.throws(
        () => dev.rmdir('/'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'not-permitted',
      );
    });
  });
});
