/**
 * FsDescriptorHandler — adapts a FileSystemProvider<Sync> to the DescriptorHandler<Sync> interface.
 * Handles both sync (Sync=true) and async (Sync=boolean) providers via a MaybePromise chain helper.
 * When the provider returns a Promise, asyncify/JSPI at the WASM boundary handles suspension and resumption.
 */

import { type MaybePromise, isThenable, chainMaybePromise as then, mapMaybePromise as map } from '@mithic/io';
import { type FileSystemProvider, type FileHandle, type FileStat, type OpenFlags as FsOpenFlags, FileSystemError } from '@mithic/io/vfs';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';
import { InputStream, OutputStream } from '../io/streams.ts';
import {
  Descriptor,
  DirectoryEntryStream,
  type Advice,
  type DescriptorFlags,
  type DescriptorHandler,
  type DescriptorStat,
  type DescriptorType,
  type MetadataHashValue,
  type NewTimestamp,
  type OpenFlags,
  type PathFlags,
  type Datetime,
} from './types.ts';

export class FsDescriptorHandler<Sync extends boolean = boolean> implements DescriptorHandler<Sync> {
  readonly #fs: FileSystemProvider<Sync>;
  readonly #path: string;
  readonly #flags: DescriptorFlags;

  constructor(fs: FileSystemProvider<Sync>, path: string, flags?: DescriptorFlags) {
    this.#fs = fs;
    this.#path = path;
    this.#flags = flags ?? { read: true, write: true, mutateDirectory: true };
  }

  getFlags(): DescriptorFlags {
    return { ...this.#flags };
  }

  readViaStream(offset: bigint): InputStream<Sync> {
    const fs = this.#fs;
    const path = this.#path;
    const openResult = fs.open(path, { read: true });
    let syncHandle: FileHandle | undefined = isThenable(openResult) ? undefined : openResult as FileHandle;
    let pos = Number(offset);

    const handler: InputStreamHandler<Sync> = {
      read(len: number): Uint8Array | undefined {
        if (!syncHandle) return undefined;
        const result = fs.read(syncHandle, pos, len);
        if (isThenable(result)) return undefined;
        if ((result as Uint8Array).byteLength === 0) return undefined;
        pos += (result as Uint8Array).byteLength;
        return result as Uint8Array;
      },
      blockingRead(len: number): MaybePromise<Uint8Array, Sync> {
        const doRead = (h: FileHandle): MaybePromise<Uint8Array, Sync> => {
          return map(fs.read(h, pos, len), data => {
            if (data.byteLength === 0) throw { tag: 'closed' };
            pos += data.byteLength;
            return data;
          });
        };
        if (syncHandle) return doRead(syncHandle);
        return then(openResult as MaybePromise<FileHandle, Sync>, h => {
          syncHandle = h;
          return doRead(h);
        });
      },
      drop() { if (syncHandle) fs.close(syncHandle); },
    };
    return new InputStream(handler);
  }

  writeViaStream(offset: bigint): OutputStream<Sync> {
    const fs = this.#fs;
    const path = this.#path;
    const openResult = fs.open(path, { write: true });
    let syncHandle: FileHandle | undefined = isThenable(openResult) ? undefined : openResult as FileHandle;
    let pos = Number(offset);
    let pendingWrite: Promise<void> | undefined;

    const handler: OutputStreamHandler<Sync> = {
      write(data: Uint8Array): void {
        const buf = new Uint8Array(data);
        if (syncHandle) {
          const result = fs.write(syncHandle, buf, pos);
          if (isThenable(result)) {
            pendingWrite = (result as Promise<number>).then(n => { pos += n; pendingWrite = undefined; });
          } else {
            pos += result as number;
          }
        } else {
          pendingWrite = (openResult as unknown as Promise<FileHandle>).then(h => {
            syncHandle = h;
            const r = fs.write(h, buf, pos);
            if (isThenable(r)) return (r as Promise<number>).then(n => { pos += n; });
            pos += r as number;
          });
        }
      },
      flush(): MaybePromise<void, Sync> { return pendingWrite as MaybePromise<void, Sync>; },
      drop() { if (syncHandle) fs.close(syncHandle); },
    };
    return new OutputStream(handler);
  }

  appendViaStream(): OutputStream<Sync> {
    const fs = this.#fs;
    const path = this.#path;
    let handle: FileHandle | undefined;
    let pos: number | undefined;
    let pendingWrite: Promise<void> | undefined;

    const handler: OutputStreamHandler<Sync> = {
      write(data: Uint8Array): void {
        const buf = new Uint8Array(data);
        const doWrite = (h: FileHandle, p: number) => {
          const result = fs.write(h, buf, p);
          if (isThenable(result)) {
            pendingWrite = (result as Promise<number>).then(n => { pos = p + n; pendingWrite = undefined; });
          } else {
            pos = p + (result as number);
          }
        };

        if (handle && pos !== undefined) { doWrite(handle, pos); return; }

        const opened = fs.open(path, { write: true, append: true });
        if (isThenable(opened)) {
          pendingWrite = (opened as Promise<FileHandle>).then(h => {
            handle = h;
            const statResult = fs.stat(path);
            if (isThenable(statResult)) {
              return (statResult as Promise<FileStat>).then(st => {
                pos = Number(st.size);
                doWrite(h, pos!);
              });
            }
            pos = Number((statResult as FileStat).size);
            doWrite(h, pos!);
          });
        } else {
          handle = opened as FileHandle;
          const statResult = fs.stat(path);
          if (isThenable(statResult)) {
            pendingWrite = (statResult as Promise<FileStat>).then(st => {
              pos = Number(st.size);
              doWrite(handle!, pos!);
            });
          } else {
            pos = Number((statResult as FileStat).size);
            doWrite(handle, pos!);
          }
        }
      },
      flush(): MaybePromise<void, Sync> {
        return pendingWrite as MaybePromise<void, Sync>;
      },
      drop() {
        if (handle) fs.close(handle);
      },
    };
    return new OutputStream(handler);
  }

  advise(_offset: bigint, _length: bigint, _advice: Advice): void {}
  syncData(): void {}
  sync(): void {}

  getType(): MaybePromise<DescriptorType, Sync> {
    return map(this.#fs.stat(this.#path), stat => fsTypeToWasi(stat.type));
  }

  setSize(size: bigint): MaybePromise<void, Sync> {
    return then(this.#fs.open(this.#path, { write: true }), handle => {
      return then(this.#fs.truncate(handle, Number(size)) as MaybePromise<void, Sync>, () => {
        this.#fs.close(handle);
      });
    });
  }

  setTimes(dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): MaybePromise<void, Sync> {
    return then(this.#fs.stat(this.#path), stat => {
      const atime = resolveTimestamp(dataAccessTimestamp, stat.atime);
      const mtime = resolveTimestamp(dataModificationTimestamp, stat.mtime);
      return this.#fs.utimes(this.#path, atime, mtime) as MaybePromise<void, Sync>;
    });
  }

  read(length: bigint, offset: bigint): MaybePromise<[Uint8Array, boolean], Sync> {
    return then(this.#fs.open(this.#path, { read: true }), handle => {
      return then(this.#fs.read(handle, Number(offset), Number(length)), data => {
        this.#fs.close(handle);
        const eof = data.byteLength < Number(length);
        return [data, eof] as [Uint8Array, boolean];
      });
    });
  }

  write(buffer: Uint8Array, offset: bigint): MaybePromise<bigint, Sync> {
    return then(this.#fs.open(this.#path, { write: true }), handle => {
      return then(this.#fs.write(handle, buffer, Number(offset)), written => {
        this.#fs.close(handle);
        return BigInt(written);
      });
    });
  }

  readDirectory(): MaybePromise<DirectoryEntryStream, Sync> {
    return map(this.#fs.readdir(this.#path), entries =>
      new DirectoryEntryStream(entries.map(e => ({ name: e.name, type: fsTypeToWasi(e.type) })))
    );
  }

  createDirectoryAt(path: string): MaybePromise<void, Sync> {
    return this.#fs.mkdir(this.#resolvePath(path)) as MaybePromise<void, Sync>;
  }

  stat(): MaybePromise<DescriptorStat, Sync> {
    return map(this.#fs.stat(this.#path), fsStatToWasi);
  }

  statAt(_pathFlags: PathFlags, path: string): MaybePromise<DescriptorStat, Sync> {
    return map(this.#fs.stat(this.#resolvePath(path)), fsStatToWasi);
  }

  setTimesAt(_pathFlags: PathFlags, path: string, atime: NewTimestamp, mtime: NewTimestamp): MaybePromise<void, Sync> {
    const fullPath = this.#resolvePath(path);
    return then(this.#fs.stat(fullPath), stat => {
      const newAtime = resolveTimestamp(atime, stat.atime);
      const newMtime = resolveTimestamp(mtime, stat.mtime);
      return this.#fs.utimes(fullPath, newAtime, newMtime) as MaybePromise<void, Sync>;
    });
  }

  linkAt(_oldPathFlags: PathFlags, oldPath: string, newDescriptor: Descriptor<Sync>, newPath: string): MaybePromise<void, Sync> {
    const handler = newDescriptor._getHandler() as FsDescriptorHandler<Sync>;
    return this.#fs.link(this.#resolvePath(oldPath), handler.#resolvePath(newPath)) as MaybePromise<void, Sync>;
  }

  openAt(_pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): MaybePromise<Descriptor<Sync>, Sync> {
    const childPath = this.#resolvePath(path);
    const fs = this.#fs;

    const finish = (): MaybePromise<Descriptor<Sync>, Sync> => {
      if (openFlags.directory) {
        return map(fs.stat(childPath), stat => {
          if (stat.type !== 'directory') throw new FileSystemError('not-directory');
          return new Descriptor<Sync>(new FsDescriptorHandler<Sync>(fs, childPath, flags));
        });
      }
      return new Descriptor<Sync>(new FsDescriptorHandler<Sync>(fs, childPath, flags)) as MaybePromise<Descriptor<Sync>, Sync>;
    };

    if (openFlags.create) {
      const fsFlags: FsOpenFlags = { create: true, write: true };
      if (openFlags.exclusive) fsFlags.exclusive = true;
      if (openFlags.truncate) fsFlags.truncate = true;
      return then(fs.open(childPath, fsFlags), handle => {
        return then(fs.close(handle) as MaybePromise<void, Sync>, () => finish());
      });
    } else if (openFlags.truncate) {
      return then(fs.open(childPath, { write: true, truncate: true }), handle => {
        return then(fs.close(handle) as MaybePromise<void, Sync>, () => finish());
      });
    }

    return finish();
  }

  readlinkAt(path: string): MaybePromise<string, Sync> {
    return this.#fs.readlink(this.#resolvePath(path)) as MaybePromise<string, Sync>;
  }

  removeDirectoryAt(path: string): MaybePromise<void, Sync> {
    return this.#fs.rmdir(this.#resolvePath(path)) as MaybePromise<void, Sync>;
  }

  renameAt(oldPath: string, newDescriptor: Descriptor<Sync>, newPath: string): MaybePromise<void, Sync> {
    const handler = newDescriptor._getHandler() as FsDescriptorHandler<Sync>;
    return this.#fs.rename(this.#resolvePath(oldPath), handler.#resolvePath(newPath)) as MaybePromise<void, Sync>;
  }

  symlinkAt(oldPath: string, newPath: string): MaybePromise<void, Sync> {
    return this.#fs.symlink(oldPath, this.#resolvePath(newPath)) as MaybePromise<void, Sync>;
  }

  unlinkFileAt(path: string): MaybePromise<void, Sync> {
    return this.#fs.unlink(this.#resolvePath(path)) as MaybePromise<void, Sync>;
  }

  isSameObject(other: Descriptor): boolean {
    const otherHandler = other._getHandler();
    if (otherHandler instanceof FsDescriptorHandler) {
      return this.#fs === otherHandler.#fs && this.#path === otherHandler.#path;
    }
    return false;
  }

  metadataHash(): MaybePromise<MetadataHashValue, Sync> {
    return map(this.stat(), stat => ({
      lower: stat.size,
      upper: stat.dataModificationTimestamp?.seconds ?? 0n,
    }));
  }

  metadataHashAt(_pathFlags: PathFlags, path: string): MaybePromise<MetadataHashValue, Sync> {
    return map(this.statAt(_pathFlags, path), stat => ({
      lower: stat.size,
      upper: stat.dataModificationTimestamp?.seconds ?? 0n,
    }));
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

/** @deprecated Use FsDescriptorHandler<true> directly. */
export type SyncFsDescriptorHandler = FsDescriptorHandler<true>;
