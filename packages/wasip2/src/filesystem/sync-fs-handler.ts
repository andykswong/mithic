/**
 * SyncFsDescriptorHandler — adapts a SyncFileSystemProvider to the DescriptorHandler interface.
 * This is the single adapter used for both in-memory (MemoryFsProvider) and
 * cross-thread (SyncBridgeFsProvider) filesystem access.
 */

import type { SyncFileSystemProvider, FileStat, OpenFlags as FsOpenFlags } from '@mithic/io/vfs';
import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '@mithic/io/io';
import { InputStream, OutputStream } from '../io/streams.ts';
import {
  Descriptor,
  DirectoryEntryStream,
  type Advice,
  type DescriptorFlags,
  type DescriptorHandler,
  type DescriptorStat,
  type DescriptorType,
  type ErrorCode,
  type MetadataHashValue,
  type NewTimestamp,
  type OpenFlags,
  type PathFlags,
  type Datetime,
} from './types.ts';

export class SyncFsDescriptorHandler implements DescriptorHandler {
  readonly #fs: SyncFileSystemProvider;
  readonly #path: string;
  readonly #flags: DescriptorFlags;

  constructor(fs: SyncFileSystemProvider, path: string, flags?: DescriptorFlags) {
    this.#fs = fs;
    this.#path = path;
    this.#flags = flags ?? { read: true, write: true, mutateDirectory: true };
  }

  getFlags(): DescriptorFlags {
    return { ...this.#flags };
  }

  readViaStream(offset: bigint): InputStream {
    const fs = this.#fs;
    const handle = fs.open(this.#path, { read: true });
    let pos = Number(offset);

    const handler: SyncInputStreamHandler = {
      read(len: number): Uint8Array | undefined {
        const data = fs.read(handle, pos, len);
        if (data.byteLength === 0) return undefined;
        pos += data.byteLength;
        return data;
      },
      blockingRead(len: number): Uint8Array {
        const data = fs.read(handle, pos, len);
        if (data.byteLength === 0) throw { tag: 'closed' };
        pos += data.byteLength;
        return data;
      },
      drop() { fs.close(handle); },
    };
    return new InputStream(handler);
  }

  writeViaStream(offset: bigint): OutputStream {
    const fs = this.#fs;
    const handle = fs.open(this.#path, { write: true });
    let pos = Number(offset);

    const handler: SyncOutputStreamHandler = {
      write(data: Uint8Array): void {
        fs.write(handle, data, pos);
        pos += data.byteLength;
      },
      flush() {},
      drop() { fs.close(handle); },
    };
    return new OutputStream(handler);
  }

  appendViaStream(): OutputStream {
    const fs = this.#fs;
    const handle = fs.open(this.#path, { write: true, append: true });
    const stat = fs.stat(this.#path);
    let pos = Number(stat.size);

    const handler: SyncOutputStreamHandler = {
      write(data: Uint8Array): void {
        fs.write(handle, data, pos);
        pos += data.byteLength;
      },
      flush() {},
      drop() { fs.close(handle); },
    };
    return new OutputStream(handler);
  }

  advise(_offset: bigint, _length: bigint, _advice: Advice): void {}
  syncData(): void {}
  sync(): void {}

  getType(): DescriptorType {
    const stat = this.#fs.stat(this.#path);
    return fsTypeToWasi(stat.type);
  }

  setSize(size: bigint): void {
    const handle = this.#fs.open(this.#path, { write: true });
    this.#fs.truncate(handle, Number(size));
    this.#fs.close(handle);
  }

  setTimes(dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): void {
    const stat = this.#fs.stat(this.#path);
    const atime = resolveTimestamp(dataAccessTimestamp, stat.atime);
    const mtime = resolveTimestamp(dataModificationTimestamp, stat.mtime);
    this.#fs.utimes(this.#path, atime, mtime);
  }

  read(length: bigint, offset: bigint): [Uint8Array, boolean] {
    const handle = this.#fs.open(this.#path, { read: true });
    const data = this.#fs.read(handle, Number(offset), Number(length));
    this.#fs.close(handle);
    const eof = data.byteLength < Number(length);
    return [data, eof];
  }

  write(buffer: Uint8Array, offset: bigint): bigint {
    const handle = this.#fs.open(this.#path, { write: true });
    const written = this.#fs.write(handle, buffer, Number(offset));
    this.#fs.close(handle);
    return BigInt(written);
  }

  readDirectory(): DirectoryEntryStream {
    const entries = this.#fs.readdir(this.#path);
    return new DirectoryEntryStream(entries.map(e => ({ name: e.name, type: fsTypeToWasi(e.type) })));
  }

  createDirectoryAt(path: string): void {
    this.#fs.mkdir(this.#resolvePath(path));
  }

  stat(): DescriptorStat {
    return fsStatToWasi(this.#fs.stat(this.#path));
  }

  statAt(_pathFlags: PathFlags, path: string): DescriptorStat {
    return fsStatToWasi(this.#fs.stat(this.#resolvePath(path)));
  }

  setTimesAt(_pathFlags: PathFlags, path: string, atime: NewTimestamp, mtime: NewTimestamp): void {
    const fullPath = this.#resolvePath(path);
    const stat = this.#fs.stat(fullPath);
    const newAtime = resolveTimestamp(atime, stat.atime);
    const newMtime = resolveTimestamp(mtime, stat.mtime);
    this.#fs.utimes(fullPath, newAtime, newMtime);
  }

  linkAt(_oldPathFlags: PathFlags, oldPath: string, newDescriptor: Descriptor, newPath: string): void {
    const handler = newDescriptor._getHandler() as SyncFsDescriptorHandler;
    this.#fs.link(this.#resolvePath(oldPath), handler.#resolvePath(newPath));
  }

  openAt(_pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): Descriptor {
    const childPath = this.#resolvePath(path);
    if (openFlags.create) {
      const fsFlags: FsOpenFlags = { create: true, write: true };
      if (openFlags.exclusive) fsFlags.exclusive = true;
      if (openFlags.truncate) fsFlags.truncate = true;
      const handle = this.#fs.open(childPath, fsFlags);
      this.#fs.close(handle);
    } else if (openFlags.truncate) {
      const handle = this.#fs.open(childPath, { write: true, truncate: true });
      this.#fs.close(handle);
    }
    if (openFlags.directory) {
      const stat = this.#fs.stat(childPath);
      if (stat.type !== 'directory') throw 'not-directory' as ErrorCode;
    }
    return new Descriptor(new SyncFsDescriptorHandler(this.#fs, childPath, flags));
  }

  readlinkAt(path: string): string {
    return this.#fs.readlink(this.#resolvePath(path));
  }

  removeDirectoryAt(path: string): void {
    this.#fs.rmdir(this.#resolvePath(path));
  }

  renameAt(oldPath: string, newDescriptor: Descriptor, newPath: string): void {
    const handler = newDescriptor._getHandler() as SyncFsDescriptorHandler;
    this.#fs.rename(this.#resolvePath(oldPath), handler.#resolvePath(newPath));
  }

  symlinkAt(oldPath: string, newPath: string): void {
    this.#fs.symlink(oldPath, this.#resolvePath(newPath));
  }

  unlinkFileAt(path: string): void {
    this.#fs.unlink(this.#resolvePath(path));
  }

  isSameObject(other: Descriptor): boolean {
    const otherHandler = other._getHandler();
    if (otherHandler instanceof SyncFsDescriptorHandler) {
      return this.#fs === otherHandler.#fs && this.#path === otherHandler.#path;
    }
    return false;
  }

  metadataHash(): MetadataHashValue {
    const stat = this.stat();
    return { lower: stat.size, upper: stat.dataModificationTimestamp?.seconds ?? 0n };
  }

  metadataHashAt(_pathFlags: PathFlags, path: string): MetadataHashValue {
    const stat = this.statAt(_pathFlags, path);
    return { lower: stat.size, upper: stat.dataModificationTimestamp?.seconds ?? 0n };
  }

  #resolvePath(subpath: string): string {
    if (subpath.startsWith('/')) return subpath;
    if (this.#path === '/') return '/' + subpath;
    return this.#path + '/' + subpath;
  }
}

function resolveTimestamp(ts: NewTimestamp, current: Date): Date {
  switch (ts.tag) {
    case 'no-change': return current;
    case 'now': return new Date();
    case 'timestamp':
      return new Date(Number(ts.val.seconds) * 1000 + Math.floor(ts.val.nanoseconds / 1_000_000));
  }
}


function msToDatetime(d: Date): Datetime {
  const ms = d.getTime();
  return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
}

function fsStatToWasi(stat: FileStat): DescriptorStat {
  return {
    type: fsTypeToWasi(stat.type),
    linkCount: stat.linkCount,
    size: stat.size,
    dataAccessTimestamp: msToDatetime(stat.atime),
    dataModificationTimestamp: msToDatetime(stat.mtime),
    statusChangeTimestamp: msToDatetime(stat.ctime),
  };
}

function fsTypeToWasi(type: string): DescriptorType {
  switch (type) {
    case 'file': return 'regular-file';
    case 'directory': return 'directory';
    case 'symlink': return 'symbolic-link';
    default: return type as DescriptorType;
  }
}
