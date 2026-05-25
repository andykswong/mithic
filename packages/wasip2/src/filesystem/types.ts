/**
 * Implements wasi:filesystem/types - filesystem types and Descriptor resource.
 * Sync in-process mode using an in-memory FileData tree (similar to jco browser shim).
 */

import type { IoError } from '../io/error.ts';
import { InputStream, OutputStream } from '../io/streams.ts';

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

export type NewTimestamp =
  | { tag: 'no-change' }
  | { tag: 'now' }
  | { tag: 'timestamp'; val: Datetime };

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

// ─── Internal file data model ───────────────────────────────────────────────

export interface FileData {
  /** File content (for regular files). */
  source?: Uint8Array | string;
  /** Directory children (for directories). */
  dir?: Record<string, FileData>;
  /** Symlink target path. */
  symlink?: string;
  /** File mode/permissions. */
  mode?: number;
  /** Last modification time in ms since epoch. */
  mtime?: number;
  /** Last access time in ms since epoch. */
  atime?: number;
  /** Creation/status-change time in ms since epoch. */
  ctime?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const timeZero: Datetime = { seconds: 0n, nanoseconds: 0 };

function msToDatetime(ms: number | undefined): Datetime | undefined {
  if (ms === undefined) return undefined;
  const seconds = BigInt(Math.floor(ms / 1000));
  const nanoseconds = (ms % 1000) * 1_000_000;
  return { seconds, nanoseconds };
}

function resolveTimestamp(ts: NewTimestamp, current: number | undefined): number | undefined {
  switch (ts.tag) {
    case 'no-change':
      return current;
    case 'now':
      return Date.now();
    case 'timestamp': {
      const { seconds, nanoseconds } = ts.val;
      return Number(seconds) * 1000 + Math.floor(nanoseconds / 1_000_000);
    }
  }
}

function getSource(entry: FileData): Uint8Array {
  if (typeof entry.source === 'string') {
    entry.source = new TextEncoder().encode(entry.source);
  }
  return entry.source ?? new Uint8Array(0);
}

function getChildEntry(parentEntry: FileData, subpath: string, openFlags: OpenFlags): FileData {
  let entry: FileData | undefined = parentEntry;
  let remaining = subpath;

  // Normalize: strip leading slash for relative resolution
  if (remaining.startsWith('/') && remaining !== '/') {
    remaining = remaining.slice(1);
  }

  let segmentIdx: number;
  do {
    if (!entry || !entry.dir) {
      throw 'not-directory' as ErrorCode;
    }
    segmentIdx = remaining.indexOf('/');
    const segment = segmentIdx === -1 ? remaining : remaining.slice(0, segmentIdx);

    if (segment === '..') {
      throw 'not-permitted' as ErrorCode;
    }
    if (segment === '' || segment === '.') {
      // skip
    } else if (entry.dir[segment] === undefined) {
      if (openFlags.create) {
        const now = Date.now();
        entry.dir[segment] = openFlags.directory
          ? { dir: {}, mtime: now, atime: now, ctime: now }
          : { source: new Uint8Array(0), mtime: now, atime: now, ctime: now };
        entry = entry.dir[segment];
      } else {
        throw 'no-entry' as ErrorCode;
      }
    } else {
      // Follow symlinks if present
      const child: FileData = entry.dir[segment];
      if (child.symlink !== undefined) {
        // Resolve symlink relative to parent entry
        entry = getChildEntry(parentEntry, child.symlink, { create: false });
      } else {
        entry = child;
      }
    }
    remaining = remaining.slice(segmentIdx + 1);
  } while (segmentIdx !== -1);

  if (!entry) {
    throw 'no-entry' as ErrorCode;
  }

  if (openFlags.exclusive && entry.source !== undefined) {
    throw 'exist' as ErrorCode;
  }

  if (openFlags.truncate && entry.source !== undefined) {
    entry.source = new Uint8Array(0);
    entry.mtime = Date.now();
  }

  return entry;
}

function getEntryType(entry: FileData): DescriptorType {
  if (entry.symlink !== undefined) return 'symbolic-link';
  if (entry.dir) return 'directory';
  if (entry.source !== undefined) return 'regular-file';
  return 'unknown';
}

function statEntry(entry: FileData): DescriptorStat {
  const type = getEntryType(entry);
  let size = 0n;
  if (type === 'regular-file') {
    const source = getSource(entry);
    size = BigInt(source.byteLength);
  } else if (type === 'symbolic-link' && entry.symlink) {
    size = BigInt(new TextEncoder().encode(entry.symlink).byteLength);
  }
  return {
    type,
    linkCount: 1n,
    size,
    dataAccessTimestamp: msToDatetime(entry.atime) ?? timeZero,
    dataModificationTimestamp: msToDatetime(entry.mtime) ?? timeZero,
    statusChangeTimestamp: msToDatetime(entry.ctime) ?? timeZero,
  };
}

/**
 * Find a parent directory entry and the final segment from a path.
 */
function resolveParentAndName(
  root: FileData,
  path: string,
): { parent: FileData; name: string } {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    throw 'invalid' as ErrorCode;
  }
  const name = segments.pop()!;
  let parent = root;
  for (const seg of segments) {
    if (seg === '..') throw 'not-permitted' as ErrorCode;
    if (!parent.dir || !parent.dir[seg]) throw 'no-entry' as ErrorCode;
    parent = parent.dir[seg];
    if (parent.symlink !== undefined) {
      parent = getChildEntry(root, parent.symlink, { create: false });
    }
  }
  if (!parent.dir) throw 'not-directory' as ErrorCode;
  return { parent, name };
}

// ─── DirectoryEntryStream ───────────────────────────────────────────────────

export class DirectoryEntryStream {
  #entries: [string, FileData][];
  #idx = 0;

  constructor(entries: [string, FileData][]) {
    this.#entries = entries;
  }

  readDirectoryEntry(): DirectoryEntry | null {
    if (this.#idx >= this.#entries.length) {
      return null;
    }
    const [name, entry] = this.#entries[this.#idx];
    this.#idx++;
    return {
      name,
      type: getEntryType(entry),
    };
  }
}

// ─── Descriptor ─────────────────────────────────────────────────────────────

export class Descriptor {
  #entry: FileData;
  #flags: DescriptorFlags;

  constructor(entry: FileData, flags?: DescriptorFlags) {
    this.#entry = entry;
    this.#flags = flags ?? { read: true, write: true, mutateDirectory: true };
  }

  /** @internal - get underlying entry for isSameObject comparison */
  _getEntry(): FileData {
    return this.#entry;
  }

  readViaStream(offset: bigint): InputStream {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const entry = this.#entry;
    let pos = Number(offset);
    return new InputStream({
      read(len: number): Uint8Array | undefined {
        const source = getSource(entry);
        if (pos >= source.byteLength) {
          return undefined;
        }
        const bytes = source.slice(pos, pos + len);
        pos += bytes.byteLength;
        return bytes;
      },
      blockingRead(len: number): Uint8Array {
        const source = getSource(entry);
        if (pos >= source.byteLength) {
          throw { tag: 'closed' };
        }
        const bytes = source.slice(pos, pos + len);
        pos += bytes.byteLength;
        return bytes;
      },
    });
  }

  writeViaStream(offset: bigint): OutputStream {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const entry = this.#entry;
    let pos = Number(offset);
    return new OutputStream({
      write(buf: Uint8Array): void {
        const source = getSource(entry);
        const needed = pos + buf.byteLength;
        if (needed > source.byteLength) {
          const newSource = new Uint8Array(needed);
          newSource.set(source, 0);
          newSource.set(buf, pos);
          entry.source = newSource;
        } else {
          const newSource = new Uint8Array(source);
          newSource.set(buf, pos);
          entry.source = newSource;
        }
        pos += buf.byteLength;
        entry.mtime = Date.now();
      },
      flush(): void {
        // No-op for in-memory
      },
    });
  }

  appendViaStream(): OutputStream {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const entry = this.#entry;
    return new OutputStream({
      write(buf: Uint8Array): void {
        const source = getSource(entry);
        const newSource = new Uint8Array(source.byteLength + buf.byteLength);
        newSource.set(source, 0);
        newSource.set(buf, source.byteLength);
        entry.source = newSource;
        entry.mtime = Date.now();
      },
      flush(): void {
        // No-op for in-memory
      },
    });
  }

  advise(_offset: bigint, _length: bigint, _advice: Advice): void {
    // Advisory only — no-op for in-memory filesystem
  }

  syncData(): void {
    // No-op for in-memory filesystem
  }

  getFlags(): DescriptorFlags {
    return { ...this.#flags };
  }

  getType(): DescriptorType {
    return getEntryType(this.#entry);
  }

  setSize(size: bigint): void {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const source = getSource(this.#entry);
    const newSize = Number(size);
    if (newSize === source.byteLength) return;
    const newSource = new Uint8Array(newSize);
    newSource.set(source.slice(0, Math.min(source.byteLength, newSize)));
    this.#entry.source = newSource;
    this.#entry.mtime = Date.now();
  }

  setTimes(dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): void {
    this.#entry.atime = resolveTimestamp(dataAccessTimestamp, this.#entry.atime);
    this.#entry.mtime = resolveTimestamp(dataModificationTimestamp, this.#entry.mtime);
    this.#entry.ctime = Date.now();
  }

  read(length: bigint, offset: bigint): [Uint8Array, boolean] {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const source = getSource(this.#entry);
    const off = Number(offset);
    const len = Number(length);
    const data = source.slice(off, off + len);
    const eof = off + len >= source.byteLength;
    this.#entry.atime = Date.now();
    return [data, eof];
  }

  write(buffer: Uint8Array, offset: bigint): bigint {
    if (this.#entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    const off = Number(offset);
    const source = getSource(this.#entry);
    const needed = off + buffer.byteLength;
    if (needed > source.byteLength) {
      const newSource = new Uint8Array(needed);
      newSource.set(source, 0);
      newSource.set(buffer, off);
      this.#entry.source = newSource;
    } else {
      const newSource = new Uint8Array(source);
      newSource.set(buffer, off);
      this.#entry.source = newSource;
    }
    this.#entry.mtime = Date.now();
    return BigInt(buffer.byteLength);
  }

  readDirectory(): DirectoryEntryStream {
    if (!this.#entry.dir) {
      throw 'bad-descriptor' as ErrorCode;
    }
    const entries = Object.entries(this.#entry.dir).sort(([a], [b]) => (a > b ? 1 : -1));
    return new DirectoryEntryStream(entries);
  }

  sync(): void {
    // No-op for in-memory filesystem
  }

  createDirectoryAt(path: string): void {
    if (!this.#entry.dir) {
      throw 'not-directory' as ErrorCode;
    }
    const { parent, name } = resolveParentAndName(this.#entry, path);
    if (parent.dir![name]) {
      throw 'exist' as ErrorCode;
    }
    const now = Date.now();
    parent.dir![name] = { dir: {}, mtime: now, atime: now, ctime: now };
  }

  stat(): DescriptorStat {
    return statEntry(this.#entry);
  }

  statAt(_pathFlags: PathFlags, path: string): DescriptorStat {
    const entry = getChildEntry(this.#entry, path, { create: false });
    return statEntry(entry);
  }

  setTimesAt(
    _pathFlags: PathFlags,
    path: string,
    dataAccessTimestamp: NewTimestamp,
    dataModificationTimestamp: NewTimestamp,
  ): void {
    const entry = getChildEntry(this.#entry, path, { create: false });
    entry.atime = resolveTimestamp(dataAccessTimestamp, entry.atime);
    entry.mtime = resolveTimestamp(dataModificationTimestamp, entry.mtime);
    entry.ctime = Date.now();
  }

  linkAt(
    _oldPathFlags: PathFlags,
    oldPath: string,
    newDescriptor: Descriptor,
    newPath: string,
  ): void {
    const sourceEntry = getChildEntry(this.#entry, oldPath, { create: false });
    if (sourceEntry.dir) {
      throw 'not-permitted' as ErrorCode;
    }
    const targetRoot = newDescriptor._getEntry();
    const { parent, name } = resolveParentAndName(targetRoot, newPath);
    if (parent.dir![name]) {
      throw 'exist' as ErrorCode;
    }
    // Hard link: reference the same object
    parent.dir![name] = sourceEntry;
  }

  openAt(
    _pathFlags: PathFlags,
    path: string,
    openFlags: OpenFlags,
    flags: DescriptorFlags,
  ): Descriptor {
    if (!this.#entry.dir) {
      throw 'not-directory' as ErrorCode;
    }
    // Permission checks
    if (
      (flags.write || flags.mutateDirectory || openFlags.truncate || openFlags.create) &&
      !this.#flags.mutateDirectory
    ) {
      throw 'read-only' as ErrorCode;
    }
    const childEntry = getChildEntry(this.#entry, path, openFlags);
    if (openFlags.directory && !childEntry.dir) {
      throw 'not-directory' as ErrorCode;
    }
    return new Descriptor(childEntry, flags);
  }

  readlinkAt(path: string): string {
    const { parent, name } = resolveParentAndName(this.#entry, path);
    const entry = parent.dir![name];
    if (!entry) {
      throw 'no-entry' as ErrorCode;
    }
    if (entry.symlink === undefined) {
      throw 'invalid' as ErrorCode;
    }
    if (entry.symlink.startsWith('/')) {
      throw 'not-permitted' as ErrorCode;
    }
    return entry.symlink;
  }

  removeDirectoryAt(path: string): void {
    const { parent, name } = resolveParentAndName(this.#entry, path);
    const entry = parent.dir![name];
    if (!entry) {
      throw 'no-entry' as ErrorCode;
    }
    if (!entry.dir) {
      throw 'not-directory' as ErrorCode;
    }
    if (Object.keys(entry.dir).length > 0) {
      throw 'not-empty' as ErrorCode;
    }
    delete parent.dir![name];
  }

  renameAt(oldPath: string, newDescriptor: Descriptor, newPath: string): void {
    const { parent: oldParent, name: oldName } = resolveParentAndName(this.#entry, oldPath);
    const entry = oldParent.dir![oldName];
    if (!entry) {
      throw 'no-entry' as ErrorCode;
    }
    const targetRoot = newDescriptor._getEntry();
    const { parent: newParent, name: newName } = resolveParentAndName(targetRoot, newPath);
    // If target exists and is a non-empty directory, fail
    const existing = newParent.dir![newName];
    if (existing?.dir && Object.keys(existing.dir).length > 0) {
      throw 'not-empty' as ErrorCode;
    }
    newParent.dir![newName] = entry;
    delete oldParent.dir![oldName];
  }

  symlinkAt(oldPath: string, newPath: string): void {
    if (oldPath.startsWith('/')) {
      throw 'not-permitted' as ErrorCode;
    }
    const { parent, name } = resolveParentAndName(this.#entry, newPath);
    if (parent.dir![name]) {
      throw 'exist' as ErrorCode;
    }
    const now = Date.now();
    parent.dir![name] = { symlink: oldPath, mtime: now, atime: now, ctime: now };
  }

  unlinkFileAt(path: string): void {
    const { parent, name } = resolveParentAndName(this.#entry, path);
    const entry = parent.dir![name];
    if (!entry) {
      throw 'no-entry' as ErrorCode;
    }
    if (entry.dir) {
      throw 'is-directory' as ErrorCode;
    }
    delete parent.dir![name];
  }

  isSameObject(other: Descriptor): boolean {
    return this.#entry === other._getEntry();
  }

  metadataHash(): MetadataHashValue {
    const source = this.#entry.source !== undefined ? getSource(this.#entry) : undefined;
    const mtime = this.#entry.mtime ?? 0;
    const size = source ? source.byteLength : 0;
    return {
      lower: BigInt(size),
      upper: BigInt(mtime),
    };
  }

  metadataHashAt(_pathFlags: PathFlags, path: string): MetadataHashValue {
    const entry = getChildEntry(this.#entry, path, { create: false });
    const source = entry.source !== undefined ? getSource(entry) : undefined;
    const mtime = entry.mtime ?? 0;
    const size = source ? source.byteLength : 0;
    return {
      lower: BigInt(size),
      upper: BigInt(mtime),
    };
  }
}

// ─── filesystemErrorCode ────────────────────────────────────────────────────

/**
 * Attempt to extract a filesystem error code from an IoError.
 * In jco, IoError wraps a payload that may contain a Node.js-style error code.
 * In our in-memory implementation, filesystem errors are thrown as ErrorCode strings
 * directly, but the IoError payload may still carry a `code` property.
 */
export function filesystemErrorCode(err: IoError): ErrorCode | undefined {
  const payload = err.payload;
  if (!payload) {
    // Try the debug string as a direct error code
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
