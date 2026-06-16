import { expect, describe, it, beforeEach } from 'vitest';
import { DeviceFsProvider } from './device.ts';
import { FileSystemError } from '../provider.ts';
import type { StdoutHandler } from './device.ts';

function expectThrows<T extends Error = Error>(fn: () => unknown): T {
  let err: T | undefined;
  expect(() => { try { fn(); } catch (e) { err = e as T; throw e; } }).toThrow();
  return err!;
}

describe('DeviceFsProvider', () => {
  let dev: DeviceFsProvider;
  let stdoutBuffer: Uint8Array[];

  beforeEach(() => {
    stdoutBuffer = [];
    const stdoutHandler: StdoutHandler = {
      write(data: Uint8Array) { stdoutBuffer.push(data); },
    };
    const stderrHandler: StdoutHandler = {
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
      expect(data.length).toBe(0);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/null', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2, 3]), 0);
      expect(written).toBe(3);
      dev.close(handle);
    });
  });

  describe('/dev/zero', () => {
    it('should return zeroed bytes of requested length', () => {
      const handle = dev.open('/zero', { read: true });
      const data = dev.read(handle, 0, 16);
      expect(data.length).toBe(16);
      expect(data.every(b => b === 0)).toBe(true);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/zero', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2]), 0);
      expect(written).toBe(2);
      dev.close(handle);
    });
  });

  describe('/dev/stdout', () => {
    it('should delegate write to handler', () => {
      const handle = dev.open('/stdout', { write: true });
      const payload = new TextEncoder().encode('hello stdout');
      dev.write(handle, payload, 0);
      expect(stdoutBuffer.length).toBe(1);
      expect(stdoutBuffer[0]).toEqual(payload);
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
      expect(data).toEqual(input);
      devWithStdin.close(handle);
    });

    it('should throw on write', () => {
      const handle = dev.open('/stdin', { write: true });
      const err = expectThrows<FileSystemError>(() => dev.write(handle, new Uint8Array([1]), 0));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
      dev.close(handle);
    });
  });

  describe('/dev/random', () => {
    it('should return requested number of bytes on read', () => {
      const handle = dev.open('/random', { read: true });
      const data = dev.read(handle, 0, 32);
      expect(data.length).toBe(32);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/random', { write: true });
      const written = dev.write(handle, new Uint8Array([1, 2, 3, 4]), 0);
      expect(written).toBe(4);
      dev.close(handle);
    });

    it('should produce different output on consecutive reads', () => {
      const handle = dev.open('/random', { read: true });
      const a = dev.read(handle, 0, 32);
      const b = dev.read(handle, 0, 32);
      const same = a.every((v, i) => v === b[i]);
      expect(same).toBe(false);
      dev.close(handle);
    });
  });

  describe('/dev/urandom', () => {
    it('should return requested number of bytes on read', () => {
      const handle = dev.open('/urandom', { read: true });
      const data = dev.read(handle, 0, 64);
      expect(data.length).toBe(64);
      dev.close(handle);
    });

    it('should accept writes silently', () => {
      const handle = dev.open('/urandom', { write: true });
      const written = dev.write(handle, new Uint8Array([5, 6]), 0);
      expect(written).toBe(2);
      dev.close(handle);
    });

    it('should produce different output on consecutive reads', () => {
      const handle = dev.open('/urandom', { read: true });
      const a = dev.read(handle, 0, 32);
      const b = dev.read(handle, 0, 32);
      const same = a.every((v, i) => v === b[i]);
      expect(same).toBe(false);
      dev.close(handle);
    });
  });

  describe('stat', () => {
    it('should return character-device type for devices', () => {
      const stat = dev.stat('/null');
      expect(stat.type).toBe('character-device');
      expect(stat.mode).toBe(0o666);
    });

    it('should return directory type for root', () => {
      const stat = dev.stat('/');
      expect(stat.type).toBe('directory');
    });

    it('should throw no-entry for unknown device', () => {
      const err = expectThrows<FileSystemError>(() => dev.stat('/unknown'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });
  });

  describe('readdir', () => {
    it('should return device names', () => {
      const entries = dev.readdir('/');
      const names = entries.map(e => e.name);
      expect(names).toContain('null');
      expect(names).toContain('zero');
      expect(names).toContain('random');
      expect(names).toContain('urandom');
      expect(names).toContain('stdin');
      expect(names).toContain('stdout');
      expect(names).toContain('stderr');
      expect(entries.length).toBe(7);
    });
  });

  describe('permission-denied operations', () => {
    it('should throw not-permitted on mkdir', () => {
      const err = expectThrows<FileSystemError>(() => dev.mkdir('/newdir'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('should throw not-permitted on unlink', () => {
      const err = expectThrows<FileSystemError>(() => dev.unlink('/null'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('should throw not-permitted on rmdir', () => {
      const err = expectThrows<FileSystemError>(() => dev.rmdir('/'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });
  });
});
