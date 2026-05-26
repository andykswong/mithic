import type { MaybePromise } from '../types.ts';

/** Descriptor type for filesystem entries. */
export type DescriptorType = 'file' | 'directory' | 'symlink' | 'block-device' | 'character-device' | 'fifo' | 'socket' | 'unknown';

/** Stat result for a filesystem entry. */
export interface FileStat {
  type: DescriptorType;
  size: bigint;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  linkCount: bigint;
}

/** A directory entry returned by readdir. */
export interface DirEntry {
  name: string;
  type: DescriptorType;
}

/** An open file handle. */
export interface FileHandle {
  fd: number;
  path: string;
  flags: OpenFlags;
}

/** Flags for opening a file. */
export interface OpenFlags {
  create?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
  directory?: boolean;
  append?: boolean;
  write?: boolean;
  read?: boolean;
}

/** Event emitted by filesystem watchers. */
export interface WatchEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
}

/** Virtual filesystem provider interface (MaybeAsync — methods return T or Promise<T>). */
export interface FileSystemProvider {
  init?(): MaybePromise<void>;
  dispose?(): MaybePromise<void>;
  open(path: string, flags: OpenFlags): MaybePromise<FileHandle>;
  close(handle: FileHandle): MaybePromise<void>;
  read(handle: FileHandle, offset: number, len: number): MaybePromise<Uint8Array>;
  write(handle: FileHandle, data: Uint8Array, offset: number): MaybePromise<number>;
  truncate(handle: FileHandle, size: number): MaybePromise<void>;
  stat(path: string, options?: { followSymlinks?: boolean }): MaybePromise<FileStat>;
  readdir(path: string): MaybePromise<DirEntry[]>;
  mkdir(path: string): MaybePromise<void>;
  unlink(path: string): MaybePromise<void>;
  rmdir(path: string): MaybePromise<void>;
  rename(oldPath: string, newPath: string): MaybePromise<void>;
  symlink(target: string, linkPath: string): MaybePromise<void>;
  readlink(path: string): MaybePromise<string>;
  link(existingPath: string, newPath: string): MaybePromise<void>;
  chmod(path: string, mode: number): MaybePromise<void>;
  utimes(path: string, atime: Date, mtime: Date): MaybePromise<void>;
  watch?(path: string, callback: (event: WatchEvent) => void): () => void;
  sync?(): MaybePromise<void>;
  realpath?(path: string): MaybePromise<string>;
}

/** Sync filesystem provider — all methods return T (no Promise). */
export interface SyncFileSystemProvider extends FileSystemProvider {
  init?(): void;
  dispose?(): void;
  open(path: string, flags: OpenFlags): FileHandle;
  close(handle: FileHandle): void;
  read(handle: FileHandle, offset: number, len: number): Uint8Array;
  write(handle: FileHandle, data: Uint8Array, offset: number): number;
  truncate(handle: FileHandle, size: number): void;
  stat(path: string, options?: { followSymlinks?: boolean }): FileStat;
  readdir(path: string): DirEntry[];
  mkdir(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  link(existingPath: string, newPath: string): void;
  chmod(path: string, mode: number): void;
  utimes(path: string, atime: Date, mtime: Date): void;
  sync?(): void;
  realpath?(path: string): string;
}

/** Error codes for VFS operations. */
export type FileSystemErrorCode =
  | 'access'
  | 'exist'
  | 'not-found'
  | 'not-directory'
  | 'is-directory'
  | 'not-empty'
  | 'invalid'
  | 'no-space'
  | 'io'
  | 'loop'
  | 'name-too-long'
  | 'permission-denied'
  | 'read-only'
  | 'cross-device'
  | 'not-supported';

/** Error thrown by VFS operations. */
export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;

  constructor(code: FileSystemErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'FileSystemError';
    this.code = code;
  }
}
