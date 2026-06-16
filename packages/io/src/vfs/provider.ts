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

/** Virtual filesystem provider interface. All methods return Promise<T>. */
export interface FileSystemProvider {
  init?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
  open(path: string, flags: OpenFlags): Promise<FileHandle> | FileHandle;
  close(handle: FileHandle): Promise<void> | void;
  read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array> | Uint8Array;
  write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> | number;
  truncate(handle: FileHandle, size: number): Promise<void> | void;
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat> | FileStat;
  readdir(path: string): Promise<DirEntry[]> | DirEntry[];
  mkdir(path: string): Promise<void> | void;
  unlink(path: string): Promise<void> | void;
  rmdir(path: string): Promise<void> | void;
  rename(oldPath: string, newPath: string): Promise<void> | void;
  symlink(target: string, linkPath: string): Promise<void> | void;
  readlink(path: string): Promise<string> | string;
  link(existingPath: string, newPath: string): Promise<void> | void;
  chmod(path: string, mode: number): Promise<void> | void;
  utimes(path: string, atime: Date, mtime: Date): Promise<void> | void;
  mkfifo(path: string): Promise<void> | void;
  watch?(path: string, callback: (event: WatchEvent) => void): () => void;
  sync?(): Promise<void> | void;
  realpath?(path: string): Promise<string> | string;
}

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
