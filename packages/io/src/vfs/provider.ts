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

/** Virtual filesystem provider interface. */
export interface FileSystemProvider {
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  open(path: string, flags: OpenFlags): Promise<FileHandle>;
  close(handle: FileHandle): Promise<void>;
  read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array>;
  write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number>;
  truncate(handle: FileHandle, size: number): Promise<void>;
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  link(existingPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  watch?(path: string, callback: (event: WatchEvent) => void): () => void;
  sync?(): Promise<void>;
  realpath?(path: string): Promise<string>;
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
