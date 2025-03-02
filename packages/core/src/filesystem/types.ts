import type { Error } from '../io/error.ts';
import type { ErrorCode } from './error.ts';

/**
 * A descriptor is a reference to a filesystem object, which may be a file, directory,
 * named pipe, special file, or other object on which filesystem calls may be made.
 * TODO: unimplemeneted.
 */
export class Descriptor {
}

/**
 * A stream of directory entries.
 * TODO: unimplemeneted.
 */
export class DirectoryEntryStream {
  /**
   * Read a single directory entry.
   * @throws {@link FileSystemError}
   */
  public readDirectoryEntry(): DirectoryEntry | undefined {
    return;
  }
}

/**
 * Attempts to extract a filesystem-related `error-code` from the stream `error` provided.
 * TODO: unimplemeneted.
 */
export function filesystemErrorCode(_error: Error): ErrorCode | undefined {
  return;
}

/** A directory entry. */
export interface DirectoryEntry {
  /** The type of the file referred to by this directory entry. */
  type: DescriptorType,
  /** The name of the object. */
  name: string;
}

/** The type of a filesystem object referenced by a descriptor. */
export const DescriptorType = {
  /** The type of the descriptor or file is unknown or is different from any of the other types specified. */
  Unknown: 'unknown',
  /** The descriptor refers to a block device inode. */
  BlockDevice: 'block-device',
  /** The descriptor refers to a character device inode. */
  CharacterDevice: 'character-device',
  /** The descriptor refers to a directory inode. */
  Directory: 'directory',
  /** The descriptor refers to a named pipe. */
  Fifo: 'fifo',
  /** The file refers to a symbolic link inode. */
  SymbolicLink: 'symbolic-link',
  /** The descriptor refers to a regular file inode. */
  RegularFile: 'regular-file',
  /** The descriptor refers to a socket. */
  Socket: 'socket',
};

export type DescriptorType = typeof DescriptorType[keyof typeof DescriptorType];
