/**
 * Implements wasi:filesystem/types - filesystem types and Descriptor resource.
 * Descriptor delegates to a DescriptorHandler (pluggable: in-memory or sync-bridge).
 */

import type { MaybePromise } from '@mithic/io';
import type { IoError } from '../io/error.ts';
import type { InputStream, OutputStream } from '../io/streams.ts';

// ─── Types matching WIT definitions ─────────────────────────────────────────

export type DescriptorType =
  | 'unknown'
  | 'block-device'
  | 'character-device'
  | 'directory'
  | 'fifo'
  | 'symbolic-link'
  | 'regular-file'
  | 'socket';

export type ErrorCode =
  | 'access'
  | 'would-block'
  | 'already'
  | 'bad-descriptor'
  | 'busy'
  | 'deadlock'
  | 'quota'
  | 'exist'
  | 'file-too-large'
  | 'illegal-byte-sequence'
  | 'in-progress'
  | 'interrupted'
  | 'invalid'
  | 'io'
  | 'is-directory'
  | 'loop'
  | 'too-many-links'
  | 'message-size'
  | 'name-too-long'
  | 'no-device'
  | 'no-entry'
  | 'no-lock'
  | 'insufficient-memory'
  | 'insufficient-space'
  | 'not-directory'
  | 'not-empty'
  | 'not-recoverable'
  | 'unsupported'
  | 'no-tty'
  | 'no-such-device'
  | 'overflow'
  | 'not-permitted'
  | 'pipe'
  | 'read-only'
  | 'invalid-seek'
  | 'text-file-busy'
  | 'cross-device';

export type Advice = 'normal' | 'sequential' | 'random' | 'will-need' | 'dont-need' | 'no-reuse';

export interface Datetime {
  seconds: bigint;
  nanoseconds: number;
}

export interface DescriptorStat {
  type: DescriptorType;
  linkCount: bigint;
  size: bigint;
  dataAccessTimestamp: Datetime | undefined;
  dataModificationTimestamp: Datetime | undefined;
  statusChangeTimestamp: Datetime | undefined;
}

export interface DirectoryEntry {
  type: DescriptorType;
  name: string;
}

export interface DescriptorFlags {
  read?: boolean;
  write?: boolean;
  fileIntegritySync?: boolean;
  dataIntegritySync?: boolean;
  requestedWriteSync?: boolean;
  mutateDirectory?: boolean;
}

export interface PathFlags {
  symlinkFollow?: boolean;
}

export interface OpenFlags {
  create?: boolean;
  directory?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
}

export interface MetadataHashValue {
  lower: bigint;
  upper: bigint;
}

export type NewTimestamp =
  | { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: Datetime };

// ─── DescriptorHandler interface ──────────────────────────────────────────────

export interface DescriptorHandler<Sync extends boolean = boolean> {
  getFlags(): DescriptorFlags;
  readViaStream(offset: bigint): InputStream<Sync>;
  writeViaStream(offset: bigint): OutputStream<Sync>;
  appendViaStream(): OutputStream<Sync>;
  advise(offset: bigint, length: bigint, advice: Advice): MaybePromise<void, Sync>;
  syncData(): MaybePromise<void, Sync>;
  getType(): MaybePromise<DescriptorType, Sync>;
  setSize(size: bigint): MaybePromise<void, Sync>;
  setTimes(dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): MaybePromise<void, Sync>;
  read(length: bigint, offset: bigint): MaybePromise<[Uint8Array, boolean], Sync>;
  write(buffer: Uint8Array, offset: bigint): MaybePromise<bigint, Sync>;
  readDirectory(): MaybePromise<DirectoryEntryStream, Sync>;
  sync(): MaybePromise<void, Sync>;
  createDirectoryAt(path: string): MaybePromise<void, Sync>;
  stat(): MaybePromise<DescriptorStat, Sync>;
  statAt(pathFlags: PathFlags, path: string): MaybePromise<DescriptorStat, Sync>;
  setTimesAt(pathFlags: PathFlags, path: string, atime: NewTimestamp, mtime: NewTimestamp): MaybePromise<void, Sync>;
  linkAt(oldPathFlags: PathFlags, oldPath: string, newDescriptor: Descriptor<Sync>, newPath: string): MaybePromise<void, Sync>;
  openAt(pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): MaybePromise<Descriptor<Sync>, Sync>;
  readlinkAt(path: string): MaybePromise<string, Sync>;
  removeDirectoryAt(path: string): MaybePromise<void, Sync>;
  renameAt(oldPath: string, newDescriptor: Descriptor<Sync>, newPath: string): MaybePromise<void, Sync>;
  symlinkAt(oldPath: string, newPath: string): MaybePromise<void, Sync>;
  unlinkFileAt(path: string): MaybePromise<void, Sync>;
  isSameObject(other: Descriptor): boolean;
  metadataHash(): MaybePromise<MetadataHashValue, Sync>;
  metadataHashAt(pathFlags: PathFlags, path: string): MaybePromise<MetadataHashValue, Sync>;
}

// ─── DirectoryEntryStream ───────────────────────────────────────────────────

export class DirectoryEntryStream {
  #entries: DirectoryEntry[];
  #idx = 0;

  constructor(entries: DirectoryEntry[]) {
    this.#entries = entries;
  }

  readDirectoryEntry(): DirectoryEntry | null {
    if (this.#idx >= this.#entries.length) {
      return null;
    }
    return this.#entries[this.#idx++];
  }
}

// ─── Descriptor ─────────────────────────────────────────────────────────────

export class Descriptor<Sync extends boolean = boolean> {
  #handler: DescriptorHandler<Sync>;

  constructor(handler: DescriptorHandler<Sync>) {
    this.#handler = handler;
  }

  /** @internal */
  _getHandler(): DescriptorHandler<Sync> {
    return this.#handler;
  }

  getFlags(): DescriptorFlags {
    return this.#handler.getFlags();
  }

  readViaStream(offset: bigint): InputStream<Sync> { return this.#handler.readViaStream(offset); }
  writeViaStream(offset: bigint): OutputStream<Sync> { return this.#handler.writeViaStream(offset); }
  appendViaStream(): OutputStream<Sync> { return this.#handler.appendViaStream(); }
  advise(offset: bigint, length: bigint, advice: Advice): MaybePromise<void, Sync> { return this.#handler.advise(offset, length, advice); }
  syncData(): MaybePromise<void, Sync> { return this.#handler.syncData(); }
  getType(): MaybePromise<DescriptorType, Sync> { return this.#handler.getType(); }
  setSize(size: bigint): MaybePromise<void, Sync> { return this.#handler.setSize(size); }
  setTimes(a: NewTimestamp, m: NewTimestamp): MaybePromise<void, Sync> { return this.#handler.setTimes(a, m); }
  read(length: bigint, offset: bigint): MaybePromise<[Uint8Array, boolean], Sync> { return this.#handler.read(length, offset); }
  write(buffer: Uint8Array, offset: bigint): MaybePromise<bigint, Sync> { return this.#handler.write(buffer, offset); }
  readDirectory(): MaybePromise<DirectoryEntryStream, Sync> { return this.#handler.readDirectory(); }
  sync(): MaybePromise<void, Sync> { return this.#handler.sync(); }
  createDirectoryAt(path: string): MaybePromise<void, Sync> { return this.#handler.createDirectoryAt(path); }
  stat(): MaybePromise<DescriptorStat, Sync> { return this.#handler.stat(); }
  statAt(pf: PathFlags, path: string): MaybePromise<DescriptorStat, Sync> { return this.#handler.statAt(pf, path); }
  setTimesAt(pf: PathFlags, path: string, a: NewTimestamp, m: NewTimestamp): MaybePromise<void, Sync> { return this.#handler.setTimesAt(pf, path, a, m); }
  linkAt(opf: PathFlags, op: string, nd: Descriptor<Sync>, np: string): MaybePromise<void, Sync> { return this.#handler.linkAt(opf, op, nd, np); }
  openAt(pf: PathFlags, path: string, of: OpenFlags, f: DescriptorFlags): MaybePromise<Descriptor<Sync>, Sync> { return this.#handler.openAt(pf, path, of, f); }
  readlinkAt(path: string): MaybePromise<string, Sync> { return this.#handler.readlinkAt(path); }
  removeDirectoryAt(path: string): MaybePromise<void, Sync> { return this.#handler.removeDirectoryAt(path); }
  renameAt(op: string, nd: Descriptor<Sync>, np: string): MaybePromise<void, Sync> { return this.#handler.renameAt(op, nd, np); }
  symlinkAt(op: string, np: string): MaybePromise<void, Sync> { return this.#handler.symlinkAt(op, np); }
  unlinkFileAt(path: string): MaybePromise<void, Sync> { return this.#handler.unlinkFileAt(path); }
  isSameObject(other: Descriptor): boolean { return this.#handler.isSameObject(other); }
  metadataHash(): MaybePromise<MetadataHashValue, Sync> { return this.#handler.metadataHash(); }
  metadataHashAt(pf: PathFlags, path: string): MaybePromise<MetadataHashValue, Sync> { return this.#handler.metadataHashAt(pf, path); }
}

// ─── filesystemErrorCode ────────────────────────────────────────────────────

export function filesystemErrorCode(err: IoError): ErrorCode | undefined {
  const payload = err.payload;
  if (!payload) {
    const msg = err.toDebugString();
    if (isErrorCode(msg)) {
      return msg as ErrorCode;
    }
    return undefined;
  }
  if (typeof payload === 'string') {
    if (isErrorCode(payload)) {
      return payload as ErrorCode;
    }
    return undefined;
  }
  if (typeof payload === 'object' && payload !== null && 'code' in payload) {
    return convertFsError((payload as { code: string }).code);
  }
  return undefined;
}

const ERROR_CODES: Set<string> = new Set([
  'access', 'would-block', 'already', 'bad-descriptor', 'busy', 'deadlock',
  'quota', 'exist', 'file-too-large', 'illegal-byte-sequence', 'in-progress',
  'interrupted', 'invalid', 'io', 'is-directory', 'loop', 'too-many-links',
  'message-size', 'name-too-long', 'no-device', 'no-entry', 'no-lock',
  'insufficient-memory', 'insufficient-space', 'not-directory', 'not-empty',
  'not-recoverable', 'unsupported', 'no-tty', 'no-such-device', 'overflow',
  'not-permitted', 'pipe', 'read-only', 'invalid-seek', 'text-file-busy', 'cross-device',
]);

function isErrorCode(s: string): boolean {
  return ERROR_CODES.has(s);
}

function convertFsError(code: string): ErrorCode | undefined {
  switch (code) {
    case 'EACCES': return 'access';
    case 'EAGAIN': case 'EWOULDBLOCK': return 'would-block';
    case 'EALREADY': return 'already';
    case 'EBADF': return 'bad-descriptor';
    case 'EBUSY': return 'busy';
    case 'EDEADLK': return 'deadlock';
    case 'EDQUOT': return 'quota';
    case 'EEXIST': return 'exist';
    case 'EFBIG': return 'file-too-large';
    case 'EILSEQ': return 'illegal-byte-sequence';
    case 'EINPROGRESS': return 'in-progress';
    case 'EINTR': return 'interrupted';
    case 'EINVAL': return 'invalid';
    case 'EIO': return 'io';
    case 'EISDIR': return 'is-directory';
    case 'ELOOP': return 'loop';
    case 'EMLINK': return 'too-many-links';
    case 'EMSGSIZE': return 'message-size';
    case 'ENAMETOOLONG': return 'name-too-long';
    case 'ENODEV': return 'no-device';
    case 'ENOENT': return 'no-entry';
    case 'ENOLCK': return 'no-lock';
    case 'ENOMEM': return 'insufficient-memory';
    case 'ENOSPC': return 'insufficient-space';
    case 'ENOTDIR': case 'ERR_FS_EISDIR': return 'not-directory';
    case 'ENOTEMPTY': return 'not-empty';
    case 'ENOTRECOVERABLE': return 'not-recoverable';
    case 'ENOTSUP': return 'unsupported';
    case 'ENOTTY': return 'no-tty';
    case 'ENXIO': return 'no-such-device';
    case 'EOVERFLOW': return 'overflow';
    case 'EPERM': return 'not-permitted';
    case 'EPIPE': return 'pipe';
    case 'EROFS': return 'read-only';
    case 'ESPIPE': return 'invalid-seek';
    case 'ETXTBSY': return 'text-file-busy';
    case 'EXDEV': return 'cross-device';
    default: return undefined;
  }
}
