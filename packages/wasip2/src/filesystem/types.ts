/**
 * Implements wasi:filesystem/types - filesystem types and Descriptor resource.
 * Descriptor delegates to a DescriptorHandler (pluggable: in-memory or sync-bridge).
 */

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

export interface DescriptorHandler {
  getFlags(): DescriptorFlags;
  readViaStream(offset: bigint): InputStream;
  writeViaStream(offset: bigint): OutputStream;
  appendViaStream(): OutputStream;
  advise(offset: bigint, length: bigint, advice: Advice): void;
  syncData(): void;
  getType(): DescriptorType;
  setSize(size: bigint): void;
  setTimes(dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): void;
  read(length: bigint, offset: bigint): [Uint8Array, boolean];
  write(buffer: Uint8Array, offset: bigint): bigint;
  readDirectory(): DirectoryEntryStream;
  sync(): void;
  createDirectoryAt(path: string): void;
  stat(): DescriptorStat;
  statAt(pathFlags: PathFlags, path: string): DescriptorStat;
  setTimesAt(pathFlags: PathFlags, path: string, atime: NewTimestamp, mtime: NewTimestamp): void;
  linkAt(oldPathFlags: PathFlags, oldPath: string, newDescriptor: Descriptor, newPath: string): void;
  openAt(pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): Descriptor;
  readlinkAt(path: string): string;
  removeDirectoryAt(path: string): void;
  renameAt(oldPath: string, newDescriptor: Descriptor, newPath: string): void;
  symlinkAt(oldPath: string, newPath: string): void;
  unlinkFileAt(path: string): void;
  isSameObject(other: Descriptor): boolean;
  metadataHash(): MetadataHashValue;
  metadataHashAt(pathFlags: PathFlags, path: string): MetadataHashValue;
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

export class Descriptor {
  #handler: DescriptorHandler;

  constructor(handler: DescriptorHandler) {
    this.#handler = handler;
  }

  /** @internal */
  _getHandler(): DescriptorHandler {
    return this.#handler;
  }

  getFlags(): DescriptorFlags {
    return this.#handler.getFlags();
  }

  readViaStream(offset: bigint): InputStream { return this.#handler.readViaStream(offset); }
  writeViaStream(offset: bigint): OutputStream { return this.#handler.writeViaStream(offset); }
  appendViaStream(): OutputStream { return this.#handler.appendViaStream(); }
  advise(offset: bigint, length: bigint, advice: Advice): void { this.#handler.advise(offset, length, advice); }
  syncData(): void { this.#handler.syncData(); }
  getType(): DescriptorType { return this.#handler.getType(); }
  setSize(size: bigint): void { this.#handler.setSize(size); }
  setTimes(a: NewTimestamp, m: NewTimestamp): void { this.#handler.setTimes(a, m); }
  read(length: bigint, offset: bigint): [Uint8Array, boolean] { return this.#handler.read(length, offset); }
  write(buffer: Uint8Array, offset: bigint): bigint { return this.#handler.write(buffer, offset); }
  readDirectory(): DirectoryEntryStream { return this.#handler.readDirectory(); }
  sync(): void { this.#handler.sync(); }
  createDirectoryAt(path: string): void { this.#handler.createDirectoryAt(path); }
  stat(): DescriptorStat { return this.#handler.stat(); }
  statAt(pf: PathFlags, path: string): DescriptorStat { return this.#handler.statAt(pf, path); }
  setTimesAt(pf: PathFlags, path: string, a: NewTimestamp, m: NewTimestamp): void { this.#handler.setTimesAt(pf, path, a, m); }
  linkAt(opf: PathFlags, op: string, nd: Descriptor, np: string): void { this.#handler.linkAt(opf, op, nd, np); }
  openAt(pf: PathFlags, path: string, of: OpenFlags, f: DescriptorFlags): Descriptor { return this.#handler.openAt(pf, path, of, f); }
  readlinkAt(path: string): string { return this.#handler.readlinkAt(path); }
  removeDirectoryAt(path: string): void { this.#handler.removeDirectoryAt(path); }
  renameAt(op: string, nd: Descriptor, np: string): void { this.#handler.renameAt(op, nd, np); }
  symlinkAt(op: string, np: string): void { this.#handler.symlinkAt(op, np); }
  unlinkFileAt(path: string): void { this.#handler.unlinkFileAt(path); }
  isSameObject(other: Descriptor): boolean { return this.#handler.isSameObject(other); }
  metadataHash(): MetadataHashValue { return this.#handler.metadataHash(); }
  metadataHashAt(pf: PathFlags, path: string): MetadataHashValue { return this.#handler.metadataHashAt(pf, path); }
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
