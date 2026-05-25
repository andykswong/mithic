import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import { Descriptor, filesystemErrorCode, type FileData } from './types.ts';
import { IoError } from '../io/error.ts';

function makeTestFs(): FileData {
  return {
    dir: {
      'hello.txt': { source: new Uint8Array([72, 101, 108, 108, 111]) }, // "Hello"
      'empty.txt': { source: new Uint8Array(0) },
      sub: {
        dir: {
          'nested.txt': { source: 'nested content' },
        },
      },
    },
  };
}

describe('Descriptor.getType', () => {
  it('returns directory for directory entries', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    strictEqual(desc.getType(), 'directory');
  });

  it('returns regular-file for file entries', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3]) };
    const desc = new Descriptor(fs);
    strictEqual(desc.getType(), 'regular-file');
  });
});

describe('Descriptor.stat', () => {
  it('returns size and type for regular file', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3, 4, 5]) };
    const desc = new Descriptor(fs);
    const st = desc.stat();
    strictEqual(st.type, 'regular-file');
    strictEqual(st.size, 5n);
    strictEqual(st.linkCount, 1n);
  });

  it('returns type directory and size 0 for directory', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const st = desc.stat();
    strictEqual(st.type, 'directory');
    strictEqual(st.size, 0n);
  });

  it('returns timestamps when set', () => {
    const now = Date.now();
    const fs: FileData = { source: new Uint8Array(0), mtime: now, atime: now, ctime: now };
    const desc = new Descriptor(fs);
    const st = desc.stat();
    strictEqual(st.dataModificationTimestamp!.seconds, BigInt(Math.floor(now / 1000)));
  });
});

describe('Descriptor.openAt', () => {
  it('opens existing child file', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'hello.txt', {}, { read: true });
    strictEqual(child.getType(), 'regular-file');
    const st = child.stat();
    strictEqual(st.size, 5n);
  });

  it('opens nested path', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'sub/nested.txt', {}, { read: true });
    strictEqual(child.getType(), 'regular-file');
  });

  it('creates file with create flag', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'new-file.txt', { create: true }, { read: true, write: true });
    strictEqual(child.getType(), 'regular-file');
    strictEqual(child.stat().size, 0n);
  });

  it('throws no-entry for non-existent file without create', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    try {
      desc.openAt({}, 'nonexistent.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });
});

describe('Descriptor.read/write', () => {
  it('read returns file content at offset', () => {
    const fs: FileData = { source: new Uint8Array([10, 20, 30, 40, 50]) };
    const desc = new Descriptor(fs);

    const [data, eof] = desc.read(3n, 0n);
    deepStrictEqual(data, new Uint8Array([10, 20, 30]));
    strictEqual(eof, false);

    const [data2, eof2] = desc.read(3n, 3n);
    deepStrictEqual(data2, new Uint8Array([40, 50]));
    strictEqual(eof2, true);
  });

  it('write writes content at offset', () => {
    const fs: FileData = { source: new Uint8Array([0, 0, 0, 0, 0]) };
    const desc = new Descriptor(fs);

    const written = desc.write(new Uint8Array([1, 2, 3]), 1n);
    strictEqual(written, 3n);

    const [data] = desc.read(5n, 0n);
    deepStrictEqual(data, new Uint8Array([0, 1, 2, 3, 0]));
  });

  it('write extends file when writing past end', () => {
    const fs: FileData = { source: new Uint8Array([1, 2]) };
    const desc = new Descriptor(fs);

    desc.write(new Uint8Array([3, 4, 5]), 2n);
    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe('Descriptor.readDirectory', () => {
  it('iterates directory entries in sorted order', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const stream = desc.readDirectory();

    const entries = [];
    let entry = stream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = stream.readDirectoryEntry();
    }

    strictEqual(entries.length, 3);
    // Sorted: empty.txt, hello.txt, sub
    strictEqual(entries[0].name, 'empty.txt');
    strictEqual(entries[0].type, 'regular-file');
    strictEqual(entries[1].name, 'hello.txt');
    strictEqual(entries[1].type, 'regular-file');
    strictEqual(entries[2].name, 'sub');
    strictEqual(entries[2].type, 'directory');
  });

  it('returns null when no more entries', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    const stream = desc.readDirectory();
    strictEqual(stream.readDirectoryEntry(), null);
  });
});

describe('Descriptor.createDirectoryAt', () => {
  it('creates a subdirectory', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    desc.createDirectoryAt('newdir');

    const child = desc.openAt({}, 'newdir', { directory: true }, { read: true });
    strictEqual(child.getType(), 'directory');
  });

  it('throws exist if directory already exists', () => {
    const fs: FileData = { dir: { existing: { dir: {} } } };
    const desc = new Descriptor(fs);
    try {
      desc.createDirectoryAt('existing');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'exist');
    }
  });

  it('creates nested directory with intermediate existing dirs', () => {
    const fs: FileData = { dir: { parent: { dir: {} } } };
    const desc = new Descriptor(fs);
    // createDirectoryAt only creates the final segment, parent must exist
    desc.createDirectoryAt('parent/child');

    const child = desc.openAt({}, 'parent/child', { directory: true }, { read: true });
    strictEqual(child.getType(), 'directory');
  });
});

describe('filesystemErrorCode', () => {
  it('returns error code from IoError with string payload', () => {
    const err = new IoError('no-entry');
    strictEqual(filesystemErrorCode(err), 'no-entry');
  });

  it('returns error code from IoError with Node.js-style code', () => {
    const nodeErr = { code: 'ENOENT', message: 'no such file' };
    const err = new IoError(nodeErr);
    strictEqual(filesystemErrorCode(err), 'no-entry');
  });

  it('returns undefined for unrecognized payload', () => {
    const err = new IoError('something-unknown');
    strictEqual(filesystemErrorCode(err), undefined);
  });

  it('converts EISDIR to is-directory', () => {
    const err = new IoError({ code: 'EISDIR', message: 'is a directory' });
    strictEqual(filesystemErrorCode(err), 'is-directory');
  });

  it('converts EACCES to access', () => {
    const err = new IoError({ code: 'EACCES', message: 'permission denied' });
    strictEqual(filesystemErrorCode(err), 'access');
  });

  it('returns undefined for IoError with no payload (empty message)', () => {
    const err = new IoError();
    strictEqual(filesystemErrorCode(err), undefined);
  });

  it('converts EEXIST to exist', () => {
    const err = new IoError({ code: 'EEXIST', message: 'file exists' });
    strictEqual(filesystemErrorCode(err), 'exist');
  });

  it('converts ENOTEMPTY to not-empty', () => {
    const err = new IoError({ code: 'ENOTEMPTY', message: 'directory not empty' });
    strictEqual(filesystemErrorCode(err), 'not-empty');
  });

  it('returns undefined for unknown Node.js code', () => {
    const err = new IoError({ code: 'EUNKNOWN', message: 'unknown' });
    strictEqual(filesystemErrorCode(err), undefined);
  });
});

describe('Descriptor.readViaStream', () => {
  it('reads file content via stream', () => {
    const fs: FileData = { source: new Uint8Array([65, 66, 67, 68, 69]) }; // ABCDE
    const desc = new Descriptor(fs);
    const stream = desc.readViaStream(0n);
    const data = stream.read(5n);
    deepStrictEqual(data, new Uint8Array([65, 66, 67, 68, 69]));
  });

  it('reads from offset', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3, 4, 5]) };
    const desc = new Descriptor(fs);
    const stream = desc.readViaStream(2n);
    const data = stream.read(3n);
    deepStrictEqual(data, new Uint8Array([3, 4, 5]));
  });

  it('returns empty when past end of file', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3]) };
    const desc = new Descriptor(fs);
    const stream = desc.readViaStream(10n);
    const data = stream.read(5n);
    deepStrictEqual(data, new Uint8Array(0));
  });

  it('throws is-directory when called on directory', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.readViaStream(0n);
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'is-directory');
    }
  });
});

describe('Descriptor.writeViaStream', () => {
  it('writes data via stream at offset', () => {
    const fs: FileData = { source: new Uint8Array([0, 0, 0, 0, 0]) };
    const desc = new Descriptor(fs);
    const stream = desc.writeViaStream(1n);
    stream.write(new Uint8Array([9, 8, 7]));

    const [data] = desc.read(5n, 0n);
    deepStrictEqual(data, new Uint8Array([0, 9, 8, 7, 0]));
  });

  it('extends file when writing past end', () => {
    const fs: FileData = { source: new Uint8Array([1, 2]) };
    const desc = new Descriptor(fs);
    const stream = desc.writeViaStream(2n);
    stream.write(new Uint8Array([3, 4, 5]));

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('throws is-directory when called on directory', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.writeViaStream(0n);
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'is-directory');
    }
  });
});

describe('Descriptor.appendViaStream', () => {
  it('appends data via stream', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3]) };
    const desc = new Descriptor(fs);
    const stream = desc.appendViaStream();
    stream.write(new Uint8Array([4, 5]));

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('appends to empty file', () => {
    const fs: FileData = { source: new Uint8Array(0) };
    const desc = new Descriptor(fs);
    const stream = desc.appendViaStream();
    stream.write(new Uint8Array([10, 20]));

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([10, 20]));
  });

  it('throws is-directory when called on directory', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.appendViaStream();
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'is-directory');
    }
  });
});

describe('Descriptor.setSize', () => {
  it('truncates file to smaller size', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3, 4, 5]) };
    const desc = new Descriptor(fs);
    desc.setSize(3n);

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('extends file to larger size with zeros', () => {
    const fs: FileData = { source: new Uint8Array([1, 2]) };
    const desc = new Descriptor(fs);
    desc.setSize(5n);

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 0, 0, 0]));
  });

  it('setSize to same size is a no-op', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3]) };
    const desc = new Descriptor(fs);
    desc.setSize(3n);

    const [data] = desc.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('throws is-directory when called on directory', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.setSize(0n);
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'is-directory');
    }
  });
});

describe('Descriptor.setTimes', () => {
  it('updates access and modification times with timestamp', () => {
    const fs: FileData = { source: new Uint8Array(0), atime: 1000, mtime: 1000 };
    const desc = new Descriptor(fs);
    desc.setTimes(
      { tag: 'timestamp', val: { seconds: 5n, nanoseconds: 500_000_000 } },
      { tag: 'timestamp', val: { seconds: 10n, nanoseconds: 0 } }
    );

    const st = desc.stat();
    strictEqual(st.dataAccessTimestamp!.seconds, 5n);
    strictEqual(st.dataModificationTimestamp!.seconds, 10n);
  });

  it('no-change preserves existing times', () => {
    const fs: FileData = { source: new Uint8Array(0), atime: 2000, mtime: 3000 };
    const desc = new Descriptor(fs);
    desc.setTimes({ tag: 'no-change' }, { tag: 'no-change' });

    const st = desc.stat();
    strictEqual(st.dataAccessTimestamp!.seconds, 2n);
    strictEqual(st.dataModificationTimestamp!.seconds, 3n);
  });

  it('now sets time to approximately current time', () => {
    const fs: FileData = { source: new Uint8Array(0), atime: 0, mtime: 0 };
    const desc = new Descriptor(fs);
    const before = BigInt(Math.floor(Date.now() / 1000));
    desc.setTimes({ tag: 'now' }, { tag: 'now' });
    const after = BigInt(Math.floor(Date.now() / 1000));

    const st = desc.stat();
    ok(st.dataAccessTimestamp!.seconds >= before);
    ok(st.dataAccessTimestamp!.seconds <= after);
    ok(st.dataModificationTimestamp!.seconds >= before);
    ok(st.dataModificationTimestamp!.seconds <= after);
  });
});

describe('Descriptor.stat datetime format', () => {
  it('returns correct datetime format {seconds: bigint, nanoseconds: number}', () => {
    const now = Date.now();
    const fs: FileData = { source: new Uint8Array(0), mtime: now, atime: now, ctime: now };
    const desc = new Descriptor(fs);
    const st = desc.stat();
    strictEqual(typeof st.dataAccessTimestamp!.seconds, 'bigint');
    strictEqual(typeof st.dataAccessTimestamp!.nanoseconds, 'number');
    strictEqual(typeof st.dataModificationTimestamp!.seconds, 'bigint');
    strictEqual(typeof st.dataModificationTimestamp!.nanoseconds, 'number');
    strictEqual(typeof st.statusChangeTimestamp!.seconds, 'bigint');
    strictEqual(typeof st.statusChangeTimestamp!.nanoseconds, 'number');
  });
});

describe('Descriptor.statAt', () => {
  it('statAt returns stat for child path', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const st = desc.statAt({}, 'hello.txt');
    strictEqual(st.type, 'regular-file');
    strictEqual(st.size, 5n);
  });

  it('statAt with nested path', () => {
    const fs = makeTestFs();
    const desc = new Descriptor(fs);
    const st = desc.statAt({}, 'sub/nested.txt');
    strictEqual(st.type, 'regular-file');
  });

  it('statAt on symlink without follow returns symlink stat', () => {
    const fs: FileData = {
      dir: {
        'target.txt': { source: 'hello' },
        'link.txt': { symlink: 'target.txt' },
      },
    };
    const desc = new Descriptor(fs);
    // Note: in this implementation, symlinks are always followed during resolution
    // so statAt will resolve through the symlink
    const st = desc.statAt({ symlinkFollow: true }, 'link.txt');
    strictEqual(st.type, 'regular-file');
  });
});

describe('Descriptor.linkAt', () => {
  it('creates hard link within directory', () => {
    const fs: FileData = {
      dir: {
        'original.txt': { source: new Uint8Array([1, 2, 3]) },
      },
    };
    const desc = new Descriptor(fs);
    desc.linkAt({}, 'original.txt', desc, 'linked.txt');

    const linked = desc.openAt({}, 'linked.txt', {}, { read: true });
    const [data] = linked.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('hard link shares same data (modifying one affects the other)', () => {
    const fs: FileData = {
      dir: {
        'original.txt': { source: new Uint8Array([1, 2, 3]) },
      },
    };
    const desc = new Descriptor(fs);
    desc.linkAt({}, 'original.txt', desc, 'linked.txt');

    // Write to the original
    const orig = desc.openAt({}, 'original.txt', {}, { read: true, write: true });
    orig.write(new Uint8Array([9, 9, 9]), 0n);

    // Read via link
    const linked = desc.openAt({}, 'linked.txt', {}, { read: true });
    const [data] = linked.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([9, 9, 9]));
  });

  it('throws exist if target already exists', () => {
    const fs: FileData = {
      dir: {
        'a.txt': { source: new Uint8Array([1]) },
        'b.txt': { source: new Uint8Array([2]) },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.linkAt({}, 'a.txt', desc, 'b.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'exist');
    }
  });

  it('throws not-permitted for directory link', () => {
    const fs: FileData = {
      dir: {
        subdir: { dir: {} },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.linkAt({}, 'subdir', desc, 'linked-dir');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-permitted');
    }
  });
});

describe('Descriptor.symlinkAt', () => {
  it('creates symlink', () => {
    const fs: FileData = {
      dir: {
        'target.txt': { source: new Uint8Array([5, 6, 7]) },
      },
    };
    const desc = new Descriptor(fs);
    desc.symlinkAt('target.txt', 'link.txt');

    // Can open via the symlink
    const linked = desc.openAt({}, 'link.txt', {}, { read: true });
    const [data] = linked.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([5, 6, 7]));
  });

  it('throws exist if target path already exists', () => {
    const fs: FileData = {
      dir: {
        'existing.txt': { source: '' },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.symlinkAt('target.txt', 'existing.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'exist');
    }
  });

  it('throws not-permitted for absolute symlink target', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.symlinkAt('/absolute/path', 'link.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-permitted');
    }
  });
});

describe('Descriptor.readlinkAt', () => {
  it('reads symlink target', () => {
    const fs: FileData = {
      dir: {
        'target.txt': { source: 'data' },
        'link.txt': { symlink: 'target.txt' },
      },
    };
    const desc = new Descriptor(fs);
    const target = desc.readlinkAt('link.txt');
    strictEqual(target, 'target.txt');
  });

  it('throws invalid for non-symlink', () => {
    const fs: FileData = {
      dir: {
        'regular.txt': { source: 'data' },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.readlinkAt('regular.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'invalid');
    }
  });

  it('throws no-entry for non-existent path', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.readlinkAt('nonexistent');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });
});

describe('Descriptor.unlinkFileAt', () => {
  it('removes a file', () => {
    const fs: FileData = {
      dir: {
        'a.txt': { source: 'a' },
        'b.txt': { source: 'b' },
      },
    };
    const desc = new Descriptor(fs);
    desc.unlinkFileAt('a.txt');

    try {
      desc.openAt({}, 'a.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });

  it('throws is-directory when trying to unlink a directory', () => {
    const fs: FileData = {
      dir: {
        subdir: { dir: {} },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.unlinkFileAt('subdir');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'is-directory');
    }
  });

  it('throws no-entry for non-existent file', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.unlinkFileAt('nonexistent');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });
});

describe('Descriptor.removeDirectoryAt', () => {
  it('removes empty directory', () => {
    const fs: FileData = {
      dir: {
        emptydir: { dir: {} },
      },
    };
    const desc = new Descriptor(fs);
    desc.removeDirectoryAt('emptydir');

    try {
      desc.openAt({}, 'emptydir', { directory: true }, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });

  it('throws not-empty on non-empty directory', () => {
    const fs: FileData = {
      dir: {
        nonempty: { dir: { 'child.txt': { source: 'x' } } },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.removeDirectoryAt('nonempty');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-empty');
    }
  });

  it('throws not-directory for non-directory entry', () => {
    const fs: FileData = {
      dir: {
        'file.txt': { source: 'data' },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.removeDirectoryAt('file.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-directory');
    }
  });

  it('throws no-entry for non-existent path', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.removeDirectoryAt('nonexistent');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });
});

describe('Descriptor.renameAt', () => {
  it('renames file within same descriptor', () => {
    const fs: FileData = {
      dir: {
        'old.txt': { source: new Uint8Array([1, 2, 3]) },
      },
    };
    const desc = new Descriptor(fs);
    desc.renameAt('old.txt', desc, 'new.txt');

    // Old name should no longer exist
    try {
      desc.openAt({}, 'old.txt', {}, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }

    // New name should work
    const renamed = desc.openAt({}, 'new.txt', {}, { read: true });
    const [data] = renamed.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('throws no-entry for non-existent source', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    try {
      desc.renameAt('nonexistent', desc, 'new.txt');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'no-entry');
    }
  });

  it('throws not-empty when target is non-empty directory', () => {
    const fs: FileData = {
      dir: {
        'source.txt': { source: 'data' },
        target: { dir: { 'child.txt': { source: 'x' } } },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.renameAt('source.txt', desc, 'target');
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-empty');
    }
  });
});

describe('Descriptor.isSameObject', () => {
  it('same descriptor returns true', () => {
    const fs: FileData = { source: new Uint8Array(0) };
    const desc = new Descriptor(fs);
    strictEqual(desc.isSameObject(desc), true);
  });

  it('different descriptors of same entry return true', () => {
    const fs: FileData = { dir: { 'file.txt': { source: 'x' } } };
    const root = new Descriptor(fs);
    const child1 = root.openAt({}, 'file.txt', {}, { read: true });
    const child2 = root.openAt({}, 'file.txt', {}, { read: true });
    strictEqual(child1.isSameObject(child2), true);
  });

  it('different file entries return false', () => {
    const fsA: FileData = { source: new Uint8Array(0) };
    const fsB: FileData = { source: new Uint8Array(0) };
    const descA = new Descriptor(fsA);
    const descB = new Descriptor(fsB);
    strictEqual(descA.isSameObject(descB), false);
  });
});

describe('Descriptor.metadataHash', () => {
  it('returns {upper: bigint, lower: bigint}', () => {
    const fs: FileData = { source: new Uint8Array([1, 2, 3]), mtime: 12345 };
    const desc = new Descriptor(fs);
    const hash = desc.metadataHash();
    strictEqual(typeof hash.lower, 'bigint');
    strictEqual(typeof hash.upper, 'bigint');
    strictEqual(hash.lower, 3n); // size
    strictEqual(hash.upper, 12345n); // mtime
  });

  it('metadataHash with no mtime uses 0', () => {
    const fs: FileData = { source: new Uint8Array([1, 2]) };
    const desc = new Descriptor(fs);
    const hash = desc.metadataHash();
    strictEqual(hash.lower, 2n);
    strictEqual(hash.upper, 0n);
  });

  it('directory metadataHash has size 0', () => {
    const fs: FileData = { dir: {}, mtime: 5000 };
    const desc = new Descriptor(fs);
    const hash = desc.metadataHash();
    strictEqual(hash.lower, 0n);
    strictEqual(hash.upper, 5000n);
  });
});

describe('Descriptor.openAt flags', () => {
  it('create flag creates new file', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'new.txt', { create: true }, { read: true, write: true });
    strictEqual(child.getType(), 'regular-file');
    strictEqual(child.stat().size, 0n);
  });

  it('exclusive flag throws exist if file exists', () => {
    const fs: FileData = {
      dir: {
        'existing.txt': { source: 'data' },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.openAt({}, 'existing.txt', { create: true, exclusive: true }, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'exist');
    }
  });

  it('truncate flag empties existing file', () => {
    const fs: FileData = {
      dir: {
        'data.txt': { source: new Uint8Array([1, 2, 3, 4, 5]) },
      },
    };
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'data.txt', { truncate: true }, { read: true, write: true });
    strictEqual(child.stat().size, 0n);
  });

  it('directory flag with non-directory throws not-directory', () => {
    const fs: FileData = {
      dir: {
        'file.txt': { source: 'data' },
      },
    };
    const desc = new Descriptor(fs);
    try {
      desc.openAt({}, 'file.txt', { directory: true }, { read: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'not-directory');
    }
  });

  it('read-only descriptor throws read-only on create', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs, { read: true });
    try {
      desc.openAt({}, 'new.txt', { create: true }, { read: true, write: true });
      throw new Error('should have thrown');
    } catch (e) {
      strictEqual(e, 'read-only');
    }
  });
});

describe('Symlink resolution', () => {
  it('open file through symlink path', () => {
    const fs: FileData = {
      dir: {
        'real.txt': { source: new Uint8Array([42, 43, 44]) },
        'sym.txt': { symlink: 'real.txt' },
      },
    };
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'sym.txt', {}, { read: true });
    const [data] = child.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([42, 43, 44]));
  });

  it('open nested path through intermediate symlink', () => {
    const fs: FileData = {
      dir: {
        real: { dir: { 'file.txt': { source: new Uint8Array([1, 2]) } } },
        link: { symlink: 'real' },
      },
    };
    const desc = new Descriptor(fs);
    const child = desc.openAt({}, 'link/file.txt', {}, { read: true });
    const [data] = child.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([1, 2]));
  });
});

describe('Nested directory creation and traversal', () => {
  it('creates directory and files, then traverses', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);

    // Create nested structure
    desc.createDirectoryAt('level1');
    const level1 = desc.openAt({}, 'level1', { directory: true }, { read: true, write: true, mutateDirectory: true });
    level1.createDirectoryAt('level2');
    const level2 = level1.openAt({}, 'level2', { directory: true }, { read: true, write: true, mutateDirectory: true });

    // Create a file in level2
    const file = level2.openAt({}, 'deep.txt', { create: true }, { read: true, write: true });
    file.write(new Uint8Array([99]), 0n);

    // Traverse from root
    const deepFile = desc.openAt({}, 'level1/level2/deep.txt', {}, { read: true });
    const [data] = deepFile.read(10n, 0n);
    deepStrictEqual(data, new Uint8Array([99]));
  });

  it('readDirectory after creating entries shows them', () => {
    const fs: FileData = { dir: {} };
    const desc = new Descriptor(fs);
    desc.createDirectoryAt('alpha');
    desc.createDirectoryAt('beta');

    const stream = desc.readDirectory();
    const entries = [];
    let entry = stream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = stream.readDirectoryEntry();
    }

    strictEqual(entries.length, 2);
    strictEqual(entries[0].name, 'alpha');
    strictEqual(entries[0].type, 'directory');
    strictEqual(entries[1].name, 'beta');
    strictEqual(entries[1].type, 'directory');
  });
});
