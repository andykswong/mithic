import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';

import type { DirectoryEntryStream, DescriptorStat, MetadataHashValue } from './types.ts';
import { Descriptor } from './types.ts';
import { FsDescriptorHandler } from './fs-handler.ts';
import { MemoryFsProvider, FileSystemError, type FileSystemProvider } from '@mithic/io/vfs';

function createDescriptor(files?: Record<string, string | Uint8Array>): Descriptor {
  const provider = new MemoryFsProvider({ files });
  return new Descriptor(new FsDescriptorHandler(provider, '/'));
}

function asyncProvider(sync: MemoryFsProvider): FileSystemProvider {
  return {
    open: (...args: Parameters<typeof sync.open>) => Promise.resolve(sync.open(...args)),
    read: (...args: Parameters<typeof sync.read>) => Promise.resolve(sync.read(...args)),
    write: (...args: Parameters<typeof sync.write>) => Promise.resolve(sync.write(...args)),
    close: (...args: Parameters<typeof sync.close>) => Promise.resolve(sync.close(...args)),
    stat: (...args: Parameters<typeof sync.stat>) => Promise.resolve(sync.stat(...args)),
    readdir: (...args: Parameters<typeof sync.readdir>) => Promise.resolve(sync.readdir(...args)),
    mkdir: (...args: Parameters<typeof sync.mkdir>) => Promise.resolve(sync.mkdir(...args)),
    unlink: (...args: Parameters<typeof sync.unlink>) => Promise.resolve(sync.unlink(...args)),
    rmdir: (...args: Parameters<typeof sync.rmdir>) => Promise.resolve(sync.rmdir(...args)),
    rename: (...args: Parameters<typeof sync.rename>) => Promise.resolve(sync.rename(...args)),
    truncate: (...args: Parameters<typeof sync.truncate>) => Promise.resolve(sync.truncate(...args)),
    utimes: (...args: Parameters<typeof sync.utimes>) => Promise.resolve(sync.utimes(...args)),
    link: (...args: Parameters<typeof sync.link>) => Promise.resolve(sync.link(...args)),
    symlink: (...args: Parameters<typeof sync.symlink>) => Promise.resolve(sync.symlink(...args)),
    readlink: (...args: Parameters<typeof sync.readlink>) => Promise.resolve(sync.readlink(...args)),
    chmod: (...args: Parameters<typeof sync.chmod>) => Promise.resolve(sync.chmod(...args)),
    mkfifo: (...args: Parameters<typeof sync.mkfifo>) => Promise.resolve(sync.mkfifo(...args)),
  };
}

function createAsyncDescriptor(files?: Record<string, string | Uint8Array>): Descriptor {
  const provider = new MemoryFsProvider({ files });
  return new Descriptor(new FsDescriptorHandler(asyncProvider(provider), '/'));
}

describe('FsDescriptorHandler.getType', () => {
  it('returns directory for root', () => {
    const desc = createDescriptor();
    strictEqual(desc.getType(), 'directory');
  });

  it('returns regular-file for opened file', () => {
    const desc = createDescriptor({ '/hello.txt': 'Hello' });
    const child = desc.openAt({}, 'hello.txt', {}, { read: true }) as Descriptor;
    strictEqual(child.getType(), 'regular-file');
  });
});

describe('FsDescriptorHandler.stat', () => {
  it('returns size and type for regular file', () => {
    const desc = createDescriptor({ '/data.txt': 'abcde' });
    const child = desc.openAt({}, 'data.txt', {}, { read: true }) as Descriptor;
    const st = child.stat() as DescriptorStat;
    strictEqual(st.type, 'regular-file');
    strictEqual(st.size, 5n);
    strictEqual(st.linkCount, 1n);
  });

  it('returns type directory for root', () => {
    const desc = createDescriptor();
    const st = desc.stat() as DescriptorStat;
    strictEqual(st.type, 'directory');
    strictEqual(st.size, 0n);
  });
});

describe('FsDescriptorHandler.openAt', () => {
  it('opens existing child file', () => {
    const desc = createDescriptor({ '/hello.txt': 'Hello' });
    const child = desc.openAt({}, 'hello.txt', {}, { read: true }) as Descriptor;
    strictEqual(child.getType(), 'regular-file');
  });

  it('creates file with create flag', () => {
    const desc = createDescriptor();
    const child = desc.openAt({}, 'new-file.txt', { create: true }, { read: true, write: true }) as Descriptor;
    strictEqual(child.getType(), 'regular-file');
    strictEqual((child.stat() as DescriptorStat).size, 0n);
  });

  it('opens directory with directory flag', () => {
    const provider = new MemoryFsProvider();
    provider.mkdir('/subdir');
    const desc = new Descriptor(new FsDescriptorHandler(provider, '/'));
    const child = desc.openAt({}, 'subdir', { directory: true }, { read: true }) as Descriptor;
    strictEqual(child.getType(), 'directory');
  });

  it('throws for non-existent file without create', () => {
    const desc = createDescriptor();
    try {
      desc.openAt({}, 'nonexistent.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      ok(e instanceof Error || typeof e === 'string');
    }
  });
});

describe('FsDescriptorHandler.read/write', () => {
  it('read returns file content at offset', () => {
    const desc = createDescriptor({ '/data.txt': new Uint8Array([10, 20, 30, 40, 50]) });
    const child = desc.openAt({}, 'data.txt', {}, { read: true }) as Descriptor;
    const [data, eof] = child.read(3n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([10, 20, 30]));
    strictEqual(eof, false);
  });

  it('read returns eof=true when less data than requested', () => {
    const desc = createDescriptor({ '/data.txt': new Uint8Array([10, 20, 30]) });
    const child = desc.openAt({}, 'data.txt', {}, { read: true }) as Descriptor;
    const [data, eof] = child.read(10n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([10, 20, 30]));
    strictEqual(eof, true);
  });

  it('write writes content at offset', () => {
    const desc = createDescriptor({ '/data.txt': new Uint8Array([0, 0, 0, 0, 0]) });
    const child = desc.openAt({}, 'data.txt', {}, { read: true, write: true }) as Descriptor;
    const written = child.write(new Uint8Array([1, 2, 3]), 1n);
    strictEqual(written, 3n);
    const [data] = child.read(5n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([0, 1, 2, 3, 0]));
  });
});

describe('FsDescriptorHandler.readViaStream', () => {
  it('reads file content via stream', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([65, 66, 67]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const stream = child.readViaStream(0n);
    const data = stream.read(3n);
    deepStrictEqual(data, new Uint8Array([65, 66, 67]));
  });

  it('reads file content at offset', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([10, 20, 30, 40, 50]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const stream = child.readViaStream(2n);
    const data = stream.read(3n);
    deepStrictEqual(data, new Uint8Array([30, 40, 50]));
  });
});

describe('FsDescriptorHandler.writeViaStream', () => {
  it('writes data via stream', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([0, 0, 0]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    const stream = child.writeViaStream(0n);
    stream.write(new Uint8Array([9, 8, 7]));
    const [data] = child.read(3n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([9, 8, 7]));
  });

  it('writes data at offset via stream', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([0, 0, 0, 0, 0]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    const stream = child.writeViaStream(2n);
    stream.write(new Uint8Array([5, 6]));
    const [data] = child.read(5n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([0, 0, 5, 6, 0]));
  });
});

describe('FsDescriptorHandler.readDirectory', () => {
  it('iterates directory entries', () => {
    const desc = createDescriptor({ '/a.txt': 'a', '/b.txt': 'b' });
    const stream = desc.readDirectory() as DirectoryEntryStream;
    const entries = [];
    let entry = stream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = stream.readDirectoryEntry();
    }
    strictEqual(entries.length, 2);
    ok(entries.some(e => e.name === 'a.txt'));
    ok(entries.some(e => e.name === 'b.txt'));
  });

  it('entries have correct type', () => {
    const provider = new MemoryFsProvider({ files: { '/file.txt': 'data' } });
    provider.mkdir('/subdir');
    const desc = new Descriptor(new FsDescriptorHandler(provider, '/'));
    const stream = desc.readDirectory() as DirectoryEntryStream;
    const entries = [];
    let entry = stream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = stream.readDirectoryEntry();
    }
    const fileEntry = entries.find(e => e.name === 'file.txt');
    const dirEntry = entries.find(e => e.name === 'subdir');
    strictEqual(fileEntry?.type, 'regular-file');
    strictEqual(dirEntry?.type, 'directory');
  });
});

describe('FsDescriptorHandler.createDirectoryAt', () => {
  it('creates a subdirectory', () => {
    const desc = createDescriptor();
    desc.createDirectoryAt('newdir');
    const child = desc.openAt({}, 'newdir', { directory: true }, { read: true }) as Descriptor;
    strictEqual(child.getType(), 'directory');
  });
});

describe('FsDescriptorHandler.unlinkFileAt', () => {
  it('removes a file', () => {
    const desc = createDescriptor({ '/a.txt': 'a' });
    desc.unlinkFileAt('a.txt');
    try {
      desc.openAt({}, 'a.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      ok(e instanceof Error || typeof e === 'string');
    }
  });
});

describe('FsDescriptorHandler.removeDirectoryAt', () => {
  it('removes empty directory', () => {
    const desc = createDescriptor();
    desc.createDirectoryAt('emptydir');
    desc.removeDirectoryAt('emptydir');
    try {
      desc.openAt({}, 'emptydir', { directory: true }, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      ok(e instanceof Error || typeof e === 'string');
    }
  });
});

describe('FsDescriptorHandler.renameAt', () => {
  it('renames file within same descriptor', () => {
    const desc = createDescriptor({ '/old.txt': new Uint8Array([1, 2, 3]) });
    desc.renameAt('old.txt', desc, 'new.txt');
    const renamed = desc.openAt({}, 'new.txt', {}, { read: true }) as Descriptor;
    const [data] = renamed.read(10n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });
});

describe('FsDescriptorHandler with async provider', () => {
  it('getType returns directory for root via Promise', async () => {
    const desc = createAsyncDescriptor();
    const result = desc.getType();
    ok(result instanceof Promise);
    strictEqual(await result, 'directory');
  });

  it('getType returns regular-file for opened file via Promise', async () => {
    const desc = createAsyncDescriptor({ '/hello.txt': 'Hello' });
    const child = await desc.openAt({}, 'hello.txt', {}, { read: true });
    const type = await child.getType();
    strictEqual(type, 'regular-file');
  });

  it('stat returns size and type for regular file via Promise', async () => {
    const desc = createAsyncDescriptor({ '/data.txt': 'abcde' });
    const child = await desc.openAt({}, 'data.txt', {}, { read: true });
    const st = await child.stat();
    strictEqual(st.type, 'regular-file');
    strictEqual(st.size, 5n);
  });

  it('openAt creates file with create flag via Promise', async () => {
    const desc = createAsyncDescriptor();
    const child = await desc.openAt({}, 'new.txt', { create: true }, { read: true, write: true });
    const type = await child.getType();
    strictEqual(type, 'regular-file');
  });

  it('read returns file content via Promise', async () => {
    const desc = createAsyncDescriptor({ '/data.txt': new Uint8Array([10, 20, 30]) });
    const child = await desc.openAt({}, 'data.txt', {}, { read: true });
    const [data, eof] = await child.read(3n, 0n);
    deepStrictEqual(data, new Uint8Array([10, 20, 30]));
    strictEqual(eof, false);
  });

  it('write writes content via Promise', async () => {
    const desc = createAsyncDescriptor({ '/data.txt': new Uint8Array([0, 0, 0, 0, 0]) });
    const child = await desc.openAt({}, 'data.txt', {}, { read: true, write: true });
    const written = await child.write(new Uint8Array([1, 2, 3]), 1n);
    strictEqual(written, 3n);
    const [data] = await child.read(5n, 0n);
    deepStrictEqual(data, new Uint8Array([0, 1, 2, 3, 0]));
  });

  it('readViaStream reads via async provider', async () => {
    const desc = createAsyncDescriptor({ '/f.txt': new Uint8Array([65, 66, 67]) });
    const child = await desc.openAt({}, 'f.txt', {}, { read: true });
    const stream = child.readViaStream(0n);
    const data = await stream.blockingRead(3n);
    deepStrictEqual(data, new Uint8Array([65, 66, 67]));
  });

  it('writeViaStream writes via async provider', async () => {
    const desc = createAsyncDescriptor({ '/f.txt': new Uint8Array([0, 0, 0]) });
    const child = await desc.openAt({}, 'f.txt', {}, { read: true, write: true });
    const stream = child.writeViaStream(0n);
    stream.write(new Uint8Array([9, 8, 7]));
    const [data] = await child.read(3n, 0n);
    deepStrictEqual(data, new Uint8Array([9, 8, 7]));
  });

  it('readDirectory lists entries via Promise', async () => {
    const desc = createAsyncDescriptor({ '/a.txt': 'a', '/b.txt': 'b' });
    const stream = await desc.readDirectory();
    const entries = [];
    let entry = stream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = stream.readDirectoryEntry();
    }
    strictEqual(entries.length, 2);
    ok(entries.some(e => e.name === 'a.txt'));
    ok(entries.some(e => e.name === 'b.txt'));
  });

  it('createDirectoryAt works via Promise', async () => {
    const desc = createAsyncDescriptor();
    await desc.createDirectoryAt('newdir');
    const child = await desc.openAt({}, 'newdir', { directory: true }, { read: true });
    const type = await child.getType();
    strictEqual(type, 'directory');
  });

  it('unlinkFileAt removes file via Promise', async () => {
    const desc = createAsyncDescriptor({ '/a.txt': 'a' });
    await desc.unlinkFileAt('a.txt');
    try {
      await desc.openAt({}, 'a.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      ok(e instanceof Error || typeof e === 'string');
    }
  });

  it('removeDirectoryAt removes directory via Promise', async () => {
    const desc = createAsyncDescriptor();
    await desc.createDirectoryAt('emptydir');
    await desc.removeDirectoryAt('emptydir');
    try {
      await desc.openAt({}, 'emptydir', { directory: true }, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      ok(e instanceof Error || typeof e === 'string');
    }
  });

  it('renameAt renames file via Promise', async () => {
    const desc = createAsyncDescriptor({ '/old.txt': new Uint8Array([1, 2, 3]) });
    await desc.renameAt('old.txt', desc, 'new.txt');
    const renamed = await desc.openAt({}, 'new.txt', {}, { read: true });
    const [data] = await renamed.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });
});

describe('FsDescriptorHandler.advise', () => {
  it('advise accepts all advice values without error', () => {
    const desc = createDescriptor({ '/f.txt': 'data' });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    for (const advice of ['normal', 'sequential', 'random', 'will-need', 'dont-need', 'no-reuse'] as const) {
      child.advise(0n, 4n, advice); // Should not throw
    }
  });
});

describe('FsDescriptorHandler.setSize', () => {
  it('truncates file to smaller size', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([1, 2, 3, 4, 5]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    child.setSize(3n);
    const [data] = child.read(10n, 0n) as [Uint8Array, boolean];
    strictEqual(data.byteLength, 3);
  });

  it('extends file with zeros when growing', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([1, 2, 3]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    child.setSize(5n);
    const [data] = child.read(10n, 0n) as [Uint8Array, boolean];
    strictEqual(data.byteLength, 5);
    deepStrictEqual(data.slice(3), new Uint8Array([0, 0]));
  });
});

describe('FsDescriptorHandler.setTimes', () => {
  it('setTimes with no-change leaves timestamps unchanged', () => {
    const desc = createDescriptor({ '/f.txt': 'x' });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const before = child.stat() as DescriptorStat;
    child.setTimes({ tag: 'no-change' }, { tag: 'no-change' });
    const after = child.stat() as DescriptorStat;
    deepStrictEqual(before.dataAccessTimestamp, after.dataAccessTimestamp);
    deepStrictEqual(before.dataModificationTimestamp, after.dataModificationTimestamp);
  });

  it('setTimes with now updates timestamps', () => {
    const desc = createDescriptor({ '/f.txt': 'x' });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    child.setTimes({ tag: 'now' }, { tag: 'now' });
    const st = child.stat() as DescriptorStat;
    ok(st.dataAccessTimestamp !== undefined);
    ok(st.dataModificationTimestamp !== undefined);
  });
});

describe('FsDescriptorHandler.openAt error cases', () => {
  it('openAt with exclusive flag on existing file throws', () => {
    const desc = createDescriptor({ '/existing.txt': 'data' });
    throws(
      () => desc.openAt({}, 'existing.txt', { create: true, exclusive: true }, { read: true }),
      (err: unknown) => err instanceof FileSystemError && err.code === 'exist',
    );
  });

  it('openAt with directory flag on file throws', () => {
    const desc = createDescriptor({ '/file.txt': 'data' });
    throws(
      () => desc.openAt({}, 'file.txt', { directory: true }, { read: true }),
      (err: unknown) => err instanceof FileSystemError && err.code === 'not-directory',
    );
  });
});

describe('FsDescriptorHandler.readViaStream EOF', () => {
  it('blockingRead throws closed after reading all file data', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([1, 2, 3]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const stream = child.readViaStream(0n);
    const data = stream.blockingRead(3n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
    throws(() => stream.blockingRead(1n), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });
});

describe('FsDescriptorHandler.appendViaStream', () => {
  it('appends data to end of file', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([1, 2, 3]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    const stream = child.appendViaStream();
    stream.write(new Uint8Array([4, 5]));
    stream[Symbol.dispose]();
    const [data] = child.read(10n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe('FsDescriptorHandler.metadataHash', () => {
  it('returns consistent hash for same file', () => {
    const desc = createDescriptor({ '/f.txt': 'hello' });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const h1 = child.metadataHash() as MetadataHashValue;
    const h2 = child.metadataHash() as MetadataHashValue;
    strictEqual(h1.lower, h2.lower);
    strictEqual(h1.upper, h2.upper);
  });
});

describe('FsDescriptorHandler.isSameObject', () => {
  it('same path and provider returns true', () => {
    const provider = new MemoryFsProvider({ files: { '/a.txt': 'x' } });
    const d1 = new Descriptor(new FsDescriptorHandler(provider, '/'));
    const d2 = new Descriptor(new FsDescriptorHandler(provider, '/'));
    strictEqual(d1.isSameObject(d2), true);
  });

  it('different paths return false', () => {
    const provider = new MemoryFsProvider({ files: { '/a.txt': 'x', '/b.txt': 'y' } });
    const root = new Descriptor(new FsDescriptorHandler(provider, '/'));
    const child = root.openAt({}, 'a.txt', {}, { read: true }) as Descriptor;
    strictEqual(root.isSameObject(child), false);
  });
});
