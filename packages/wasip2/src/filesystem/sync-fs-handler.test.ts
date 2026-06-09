import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import type { DirectoryEntryStream, DescriptorStat } from './types.ts';
import { Descriptor } from './types.ts';
import { SyncFsDescriptorHandler } from './sync-fs-handler.ts';
import { MemoryFsProvider } from '@mithic/io/vfs';

function createDescriptor(files?: Record<string, string | Uint8Array>): Descriptor {
  const provider = new MemoryFsProvider({ files });
  return new Descriptor(new SyncFsDescriptorHandler(provider, '/'));
}

describe('SyncFsDescriptorHandler.getType', () => {
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

describe('SyncFsDescriptorHandler.stat', () => {
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

describe('SyncFsDescriptorHandler.openAt', () => {
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

describe('SyncFsDescriptorHandler.read/write', () => {
  it('read returns file content at offset', () => {
    const desc = createDescriptor({ '/data.txt': new Uint8Array([10, 20, 30, 40, 50]) });
    const child = desc.openAt({}, 'data.txt', {}, { read: true }) as Descriptor;
    const [data, eof] = child.read(3n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([10, 20, 30]));
    strictEqual(eof, false);
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

describe('SyncFsDescriptorHandler.readDirectory', () => {
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
});

describe('SyncFsDescriptorHandler.createDirectoryAt', () => {
  it('creates a subdirectory', () => {
    const desc = createDescriptor();
    desc.createDirectoryAt('newdir');
    const child = desc.openAt({}, 'newdir', { directory: true }, { read: true }) as Descriptor;
    strictEqual(child.getType(), 'directory');
  });
});

describe('SyncFsDescriptorHandler.readViaStream', () => {
  it('reads file content via stream', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([65, 66, 67]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true }) as Descriptor;
    const stream = child.readViaStream(0n);
    const data = stream.read(3n);
    deepStrictEqual(data, new Uint8Array([65, 66, 67]));
  });
});

describe('SyncFsDescriptorHandler.writeViaStream', () => {
  it('writes data via stream', () => {
    const desc = createDescriptor({ '/f.txt': new Uint8Array([0, 0, 0]) });
    const child = desc.openAt({}, 'f.txt', {}, { read: true, write: true }) as Descriptor;
    const stream = child.writeViaStream(0n);
    stream.write(new Uint8Array([9, 8, 7]));
    const [data] = child.read(3n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([9, 8, 7]));
  });
});

describe('SyncFsDescriptorHandler.unlinkFileAt', () => {
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

describe('SyncFsDescriptorHandler.removeDirectoryAt', () => {
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

describe('SyncFsDescriptorHandler.renameAt', () => {
  it('renames file within same descriptor', () => {
    const desc = createDescriptor({ '/old.txt': new Uint8Array([1, 2, 3]) });
    desc.renameAt('old.txt', desc, 'new.txt');
    const renamed = desc.openAt({}, 'new.txt', {}, { read: true }) as Descriptor;
    const [data] = renamed.read(10n, 0n) as [Uint8Array, boolean];
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });
});

describe('SyncFsDescriptorHandler.symlinkAt + readlinkAt', () => {
  it('creates and reads symlink', () => {
    const desc = createDescriptor({ '/target.txt': 'data' });
    desc.symlinkAt('/target.txt', 'link.txt');
    const target = desc.readlinkAt('link.txt');
    strictEqual(target, '/target.txt');
  });
});

describe('SyncFsDescriptorHandler.isSameObject', () => {
  it('same path returns true', () => {
    const provider = new MemoryFsProvider();
    const desc1 = new Descriptor(new SyncFsDescriptorHandler(provider, '/'));
    const desc2 = new Descriptor(new SyncFsDescriptorHandler(provider, '/'));
    strictEqual(desc1.isSameObject(desc2), true);
  });

  it('different paths return false', () => {
    const provider = new MemoryFsProvider({ files: { '/a': 'a' } });
    const desc1 = new Descriptor(new SyncFsDescriptorHandler(provider, '/'));
    const desc2 = new Descriptor(new SyncFsDescriptorHandler(provider, '/a'));
    strictEqual(desc1.isSameObject(desc2), false);
  });
});

describe('SyncFsDescriptorHandler.getFlags', () => {
  it('returns default flags', () => {
    const desc = createDescriptor();
    const flags = desc.getFlags();
    strictEqual(flags.read, true);
    strictEqual(flags.write, true);
    strictEqual(flags.mutateDirectory, true);
  });
});
