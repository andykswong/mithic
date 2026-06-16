import { expect, describe, it, beforeEach } from 'vitest';
import { OPFSProvider, type OPFSStorageManager } from './opfs.ts';

// ─── Minimal in-memory OPFS mock ─────────────────────────────────────────────

class MockFile {
  readonly name: string;
  #data: Uint8Array;

  constructor(name: string, data = new Uint8Array(0)) {
    this.name = name;
    this.#data = data;
  }

  get size() { return this.#data.byteLength; }
  get lastModified() { return Date.now(); }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.#data);
    return copy.buffer as ArrayBuffer;
  }

  slice(start?: number, end?: number): MockFile {
    return new MockFile(this.name, this.#data.slice(start ?? 0, end ?? this.#data.byteLength));
  }

  _setData(data: Uint8Array) { this.#data = data; }
  _getData(): Uint8Array { return this.#data; }
}

class MockWritableFileStream {
  #file: MockFileHandle;
  #position = 0;
  #data: Uint8Array;

  constructor(fileHandle: MockFileHandle, keepExistingData: boolean) {
    this.#file = fileHandle;
    this.#data = keepExistingData ? new Uint8Array(fileHandle._file._getData()) : new Uint8Array(0);
  }

  async write(input: unknown): Promise<void> {
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
      this.#writeAt(bytes, this.#position);
      this.#position += bytes.byteLength;
    }
  }

  async seek(position: number): Promise<void> {
    this.#position = position;
  }

  async truncate(size: number): Promise<void> {
    const newData = new Uint8Array(size);
    newData.set(this.#data.subarray(0, Math.min(this.#data.byteLength, size)));
    this.#data = newData;
    if (this.#position > size) this.#position = size;
  }

  async close(): Promise<void> {
    this.#file._file._setData(new Uint8Array(this.#data));
  }

  #writeAt(bytes: Uint8Array, offset: number): void {
    const needed = offset + bytes.byteLength;
    if (needed > this.#data.byteLength) {
      const newData = new Uint8Array(needed);
      newData.set(this.#data);
      this.#data = newData;
    }
    this.#data.set(bytes, offset);
  }
}

class MockFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  _file: MockFile;

  constructor(name: string) {
    this.name = name;
    this._file = new MockFile(name);
  }

  async getFile() { return this._file; }
  async createWritable(options?: { keepExistingData?: boolean }) {
    return new MockWritableFileStream(this, options?.keepExistingData ?? false);
  }
}

class MockDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  #entries = new Map<string, MockFileHandle | MockDirectoryHandle>();

  constructor(name: string) { this.name = name; }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const entry = this.#entries.get(name);
    if (entry && entry.kind === 'file') return entry as MockFileHandle;
    if (entry) throw new Error('TypeMismatchError');
    if (!options?.create) throw new Error('Not found');
    const handle = new MockFileHandle(name);
    this.#entries.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const entry = this.#entries.get(name);
    if (entry && entry.kind === 'directory') return entry as MockDirectoryHandle;
    if (entry) throw new Error('TypeMismatchError');
    if (!options?.create) throw new Error('Not found');
    const handle = new MockDirectoryHandle(name);
    this.#entries.set(name, handle);
    return handle;
  }

  async removeEntry(name: string) {
    if (!this.#entries.has(name)) throw new Error('Not found');
    this.#entries.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirectoryHandle]> {
    for (const [name, handle] of this.#entries) yield [name, handle];
  }
}

function createMockStorage(): OPFSStorageManager {
  const root = new MockDirectoryHandle('');
  return { getDirectory: async () => root as unknown as FileSystemDirectoryHandle };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OPFSProvider', () => {
  let provider: OPFSProvider;

  beforeEach(async () => {
    provider = new OPFSProvider(createMockStorage());
    await provider.init();
  });

  describe('open + read + write', () => {
    it('creates a file and reads it back', async () => {
      const handle = await provider.open('/test.txt', { create: true, write: true });
      const written = await provider.write(handle, new TextEncoder().encode('hello'), 0);
      expect(written).toBe(5);
      await provider.close(handle);

      const readHandle = await provider.open('/test.txt', { read: true });
      const data = await provider.read(readHandle, 0, 10);
      expect(new TextDecoder().decode(data)).toBe('hello');
      await provider.close(readHandle);
    });

    it('throws for non-existent file without create', async () => {
      await expect(provider.open('/nonexistent.txt', { read: true })).rejects.toThrow();
    });
  });

  describe('stat', () => {
    it('returns file stat with size', async () => {
      const handle = await provider.open('/stat-test.txt', { create: true, write: true });
      await provider.write(handle, new TextEncoder().encode('abc'), 0);
      await provider.close(handle);

      const stat = await provider.stat('/stat-test.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(3n);
    });

    it('returns directory stat', async () => {
      await provider.mkdir('/testdir');
      const stat = await provider.stat('/testdir');
      expect(stat.type).toBe('directory');
    });
  });

  describe('mkdir + readdir', () => {
    it('creates directory and lists it', async () => {
      await provider.mkdir('/mydir');
      const entries = await provider.readdir('/');
      expect(entries.some(e => e.name === 'mydir' && e.type === 'directory')).toBe(true);
    });
  });

  describe('unlink', () => {
    it('removes a file', async () => {
      const handle = await provider.open('/del.txt', { create: true, write: true });
      await provider.write(handle, new Uint8Array([1]), 0);
      await provider.close(handle);

      await provider.unlink('/del.txt');
      await expect(provider.stat('/del.txt')).rejects.toThrow();
    });
  });

  describe('rmdir', () => {
    it('removes empty directory', async () => {
      await provider.mkdir('/emptydir');
      await provider.rmdir('/emptydir');
      await expect(provider.stat('/emptydir')).rejects.toThrow();
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const handle = await provider.open('/old.txt', { create: true, write: true });
      await provider.write(handle, new TextEncoder().encode('data'), 0);
      await provider.close(handle);

      await provider.rename('/old.txt', '/new.txt');
      const stat = await provider.stat('/new.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(4n);
    });
  });

  describe('truncate', () => {
    it('truncates file to specified size', async () => {
      const handle = await provider.open('/trunc.txt', { create: true, write: true });
      await provider.write(handle, new TextEncoder().encode('hello world'), 0);
      await provider.truncate(handle, 5);
      await provider.close(handle);

      const stat = await provider.stat('/trunc.txt');
      expect(stat.size).toBe(5n);
    });
  });
});
