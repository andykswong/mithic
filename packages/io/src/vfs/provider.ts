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

/** Virtual filesystem provider interface, parameterized by sync mode. */
export interface FileSystemProvider<Sync extends boolean = boolean> {
  init?(): MaybePromise<void, Sync>;
  dispose?(): MaybePromise<void, Sync>;
  open(path: string, flags: OpenFlags): MaybePromise<FileHandle, Sync>;
  close(handle: FileHandle): MaybePromise<void, Sync>;
  read(handle: FileHandle, offset: number, len: number): MaybePromise<Uint8Array, Sync>;
  write(handle: FileHandle, data: Uint8Array, offset: number): MaybePromise<number, Sync>;
  truncate(handle: FileHandle, size: number): MaybePromise<void, Sync>;
  stat(path: string, options?: { followSymlinks?: boolean }): MaybePromise<FileStat, Sync>;
  readdir(path: string): MaybePromise<DirEntry[], Sync>;
  mkdir(path: string): MaybePromise<void, Sync>;
  unlink(path: string): MaybePromise<void, Sync>;
  rmdir(path: string): MaybePromise<void, Sync>;
  rename(oldPath: string, newPath: string): MaybePromise<void, Sync>;
  symlink(target: string, linkPath: string): MaybePromise<void, Sync>;
  readlink(path: string): MaybePromise<string, Sync>;
  link(existingPath: string, newPath: string): MaybePromise<void, Sync>;
  chmod(path: string, mode: number): MaybePromise<void, Sync>;
  utimes(path: string, atime: Date, mtime: Date): MaybePromise<void, Sync>;
  mkfifo(path: string): MaybePromise<void, Sync>;
  watch?(path: string, callback: (event: WatchEvent) => void): () => void;
  sync?(): MaybePromise<void, Sync>;
  realpath?(path: string): MaybePromise<string, Sync>;
}

/** Sync filesystem provider — all methods return T (no Promise). */
export type SyncFileSystemProvider = FileSystemProvider<true>;

/** Error codes for VFS operations (aligned with WIT wasi:filesystem error-code names). */
export type FileSystemErrorCode =
  | 'access'
  | 'exist'
  | 'no-entry'
  | 'not-directory'
  | 'is-directory'
  | 'not-empty'
  | 'invalid'
  | 'insufficient-space'
  | 'io'
  | 'loop'
  | 'name-too-long'
  | 'not-permitted'
  | 'read-only'
  | 'cross-device'
  | 'unsupported';

/** Error thrown by VFS operations. */
export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;
  readonly payload: FileSystemErrorCode;

  constructor(code: FileSystemErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'FileSystemError';
    this.code = code;
    this.payload = code;
  }
}
