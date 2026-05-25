import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { DeviceProvider } from './device.ts';
import { FileSystemError } from '../provider.ts';

describe('DeviceProvider', () => {
  let dev: DeviceProvider;
  let stdoutBuffer: Uint8Array[];

  beforeEach(() => {
    stdoutBuffer = [];
    dev = new DeviceProvider({
      stdout: async (data) => { stdoutBuffer.push(data); },
      stderr: async () => {},
    });
  });

  describe('/dev/null', () => {
    it('should return empty on read', async () => {
      const handle = await dev.open('/null', { read: true });
      const data = await dev.read(handle, 0, 1024);
      assert.strictEqual(data.length, 0);
      await dev.close(handle);
    });

    it('should accept writes silently', async () => {
      const handle = await dev.open('/null', { write: true });
      const written = await dev.write(handle, new Uint8Array([1, 2, 3]), 0);
      assert.strictEqual(written, 3);
      await dev.close(handle);
    });
  });

  describe('/dev/zero', () => {
    it('should return zeroed bytes of requested length', async () => {
      const handle = await dev.open('/zero', { read: true });
      const data = await dev.read(handle, 0, 16);
      assert.strictEqual(data.length, 16);
      assert(data.every(b => b === 0));
      await dev.close(handle);
    });
  });

  describe('/dev/stdout', () => {
    it('should delegate write to handler', async () => {
      const handle = await dev.open('/stdout', { write: true });
      const payload = new TextEncoder().encode('hello stdout');
      await dev.write(handle, payload, 0);
      assert.strictEqual(stdoutBuffer.length, 1);
      assert.deepStrictEqual(stdoutBuffer[0], payload);
      await dev.close(handle);
    });
  });

  describe('stat', () => {
    it('should return character-device type for devices', async () => {
      const stat = await dev.stat('/null');
      assert.strictEqual(stat.type, 'character-device');
    });

    it('should return directory type for root', async () => {
      const stat = await dev.stat('/');
      assert.strictEqual(stat.type, 'directory');
    });
  });

  describe('readdir', () => {
    it('should return device names', async () => {
      const entries = await dev.readdir('/');
      const names = entries.map(e => e.name);
      assert(names.includes('null'));
      assert(names.includes('zero'));
      assert(names.includes('stdin'));
      assert(names.includes('stdout'));
      assert(names.includes('stderr'));
      assert.strictEqual(entries.length, 5);
    });
  });

  describe('permission-denied operations', () => {
    it('should throw permission-denied on mkdir', async () => {
      await assert.rejects(
        () => dev.mkdir('/newdir'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'permission-denied'
      );
    });

    it('should throw permission-denied on chmod', async () => {
      await assert.rejects(
        () => dev.chmod('/null', 0o777),
        (err: unknown) => err instanceof FileSystemError && err.code === 'permission-denied'
      );
    });

    it('should throw permission-denied on unlink', async () => {
      await assert.rejects(
        () => dev.unlink('/null'),
        (err: unknown) => err instanceof FileSystemError && err.code === 'permission-denied'
      );
    });
  });
});
