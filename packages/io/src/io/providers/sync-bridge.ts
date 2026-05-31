/**
 * Sync-bridge-backed providers for use in WASM worker threads.
 *
 * These implementations dispatch through WorkerIo.ioCall() and block until
 * the I/O loop resolves the operation. They implement the Sync* interfaces,
 * returning values directly (not Promises).
 */

import type { WorkerIo } from '../worker-io.ts';
import type { SyncFileSystemProvider, FileHandle, OpenFlags, FileStat, DirEntry } from '../../vfs/provider.ts';
import type { SyncHttpClient, HttpRequest, HttpResponse } from '../../net/http.ts';
import type { SyncSocketProvider, SyncTcpSocket, SyncUdpSocket, IpAddress, SocketAddress } from '../../net/sockets.ts';
import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '../streams.ts';
import {
  STDIN, STDOUT, STDERR, FILE, SOCKET_UDP,
  INPUT_STREAM_READ, INPUT_STREAM_BLOCKING_READ, INPUT_STREAM_DISPOSE,
  OUTPUT_STREAM_WRITE, OUTPUT_STREAM_FLUSH, OUTPUT_STREAM_DISPOSE,
  HTTP_SEND,
  FS_OPEN, FS_CLOSE, FS_READ, FS_WRITE, FS_STAT, FS_READDIR,
  FS_MKDIR, FS_UNLINK, FS_RMDIR, FS_RENAME, FS_SYMLINK, FS_READLINK,
  FS_CHMOD, FS_UTIMES, FS_TRUNCATE, FS_LINK, FS_REALPATH, FS_MKFIFO,
  SOCKET_CREATE, SOCKET_BIND, SOCKET_CONNECT, SOCKET_LISTEN,
  SOCKET_ACCEPT, SOCKET_SEND, SOCKET_RECV, SOCKET_CLOSE, SOCKET_RESOLVE,
} from '../calls.ts';

// ─── Stream handlers ─────────────────────────────────────────────────────────

export class SyncBridgeInputStreamHandler implements SyncInputStreamHandler {
  readonly #io: WorkerIo;
  readonly #resourceType: number;

  constructor(io: WorkerIo, resourceType: number = STDIN) {
    this.#io = io;
    this.#resourceType = resourceType;
  }

  read(len: number): Uint8Array | undefined {
    const result = this.#io.ioCall(INPUT_STREAM_READ | this.#resourceType, null, { len });
    const data = result as Uint8Array;
    return data.byteLength === 0 ? undefined : data;
  }

  blockingRead(len: number): Uint8Array {
    const result = this.#io.ioCall(INPUT_STREAM_BLOCKING_READ | this.#resourceType, null, { len });
    return result as Uint8Array;
  }

  drop(): void {
    this.#io.ioCall(INPUT_STREAM_DISPOSE | this.#resourceType, null);
  }
}

export class SyncBridgeOutputStreamHandler implements SyncOutputStreamHandler {
  readonly #io: WorkerIo;
  readonly #resourceType: number;

  constructor(io: WorkerIo, resourceType: number = STDOUT) {
    this.#io = io;
    this.#resourceType = resourceType;
  }

  write(data: Uint8Array): void {
    this.#io.ioCall(OUTPUT_STREAM_WRITE | this.#resourceType, null, { data });
  }

  flush(): void {
    this.#io.ioCall(OUTPUT_STREAM_FLUSH | this.#resourceType, null);
  }

  drop(): void {
    this.#io.ioCall(OUTPUT_STREAM_DISPOSE | this.#resourceType, null);
  }
}

export function createStdinHandler(io: WorkerIo): SyncBridgeInputStreamHandler {
  return new SyncBridgeInputStreamHandler(io, STDIN);
}

export function createStdoutHandler(io: WorkerIo): SyncBridgeOutputStreamHandler {
  return new SyncBridgeOutputStreamHandler(io, STDOUT);
}

export function createStderrHandler(io: WorkerIo): SyncBridgeOutputStreamHandler {
  return new SyncBridgeOutputStreamHandler(io, STDERR);
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

export class SyncBridgeHttpClient implements SyncHttpClient {
  readonly #io: WorkerIo;

  constructor(io: WorkerIo) {
    this.#io = io;
  }

  send(request: HttpRequest): HttpResponse {
    return this.#io.ioCall(HTTP_SEND, null, request) as HttpResponse;
  }
}

// ─── Socket provider ─────────────────────────────────────────────────────────

class SyncBridgeTcpSocket implements SyncTcpSocket {
  readonly #io: WorkerIo;
  readonly #socketId: number;

  constructor(io: WorkerIo, socketId: number) {
    this.#io = io;
    this.#socketId = socketId;
  }

  bind(address: SocketAddress): void {
    this.#io.ioCall(SOCKET_BIND, this.#socketId, { address });
  }

  connect(address: SocketAddress): void {
    this.#io.ioCall(SOCKET_CONNECT, this.#socketId, { address });
  }

  listen(backlog?: number): void {
    this.#io.ioCall(SOCKET_LISTEN, this.#socketId, { backlog });
  }

  accept(): SyncBridgeTcpSocket {
    const acceptedId = this.#io.ioCall(SOCKET_ACCEPT, this.#socketId, null) as number;
    return new SyncBridgeTcpSocket(this.#io, acceptedId);
  }

  send(data: Uint8Array): number {
    return this.#io.ioCall(SOCKET_SEND, this.#socketId, { data }) as number;
  }

  receive(len: number): Uint8Array {
    return this.#io.ioCall(SOCKET_RECV, this.#socketId, { len }) as Uint8Array;
  }

  shutdown(): void {
    this.#io.ioCall(SOCKET_CLOSE, this.#socketId, null);
  }

  close(): void {
    this.#io.ioCall(SOCKET_CLOSE, this.#socketId, null);
  }

  localAddress(): SocketAddress | undefined {
    return undefined;
  }

  remoteAddress(): SocketAddress | undefined {
    return undefined;
  }
}

class SyncBridgeUdpSocket implements SyncUdpSocket {
  readonly #io: WorkerIo;
  readonly #socketId: number;

  constructor(io: WorkerIo, socketId: number) {
    this.#io = io;
    this.#socketId = socketId;
  }

  bind(address: SocketAddress): void {
    this.#io.ioCall(SOCKET_BIND | SOCKET_UDP, this.#socketId, { address });
  }

  send(data: Uint8Array, remoteAddress: SocketAddress): number {
    return this.#io.ioCall(SOCKET_SEND | SOCKET_UDP, this.#socketId, { data, remoteAddress }) as number;
  }

  receive(len: number): { data: Uint8Array; remoteAddress: SocketAddress } {
    return this.#io.ioCall(SOCKET_RECV | SOCKET_UDP, this.#socketId, { len }) as { data: Uint8Array; remoteAddress: SocketAddress };
  }

  close(): void {
    this.#io.ioCall(SOCKET_CLOSE | SOCKET_UDP, this.#socketId, null);
  }

  localAddress(): SocketAddress | undefined {
    return undefined;
  }
}

export class SyncBridgeSocketProvider implements SyncSocketProvider {
  readonly #io: WorkerIo;

  constructor(io: WorkerIo) {
    this.#io = io;
  }

  createTcpSocket(): SyncBridgeTcpSocket {
    const socketId = this.#io.ioCall(SOCKET_CREATE, null, null) as number;
    return new SyncBridgeTcpSocket(this.#io, socketId);
  }

  createUdpSocket(): SyncBridgeUdpSocket {
    const socketId = this.#io.ioCall(SOCKET_CREATE | SOCKET_UDP, null, null) as number;
    return new SyncBridgeUdpSocket(this.#io, socketId);
  }

  resolveName(name: string): IpAddress[] {
    return this.#io.ioCall(SOCKET_RESOLVE, null, { name }) as IpAddress[];
  }
}

// ─── Filesystem provider ─────────────────────────────────────────────────────

export class SyncBridgeFsProvider implements SyncFileSystemProvider {
  readonly #io: WorkerIo;

  constructor(io: WorkerIo) {
    this.#io = io;
  }

  open(path: string, flags: OpenFlags): FileHandle {
    return this.#io.ioCall(FS_OPEN | FILE, null, { path, flags }) as FileHandle;
  }

  close(handle: FileHandle): void {
    this.#io.ioCall(FS_CLOSE | FILE, handle.fd, null);
  }

  read(handle: FileHandle, offset: number, len: number): Uint8Array {
    return this.#io.ioCall(FS_READ | FILE, handle.fd, { offset, len }) as Uint8Array;
  }

  write(handle: FileHandle, data: Uint8Array, offset: number): number {
    return this.#io.ioCall(FS_WRITE | FILE, handle.fd, { data, offset }) as number;
  }

  truncate(handle: FileHandle, size: number): void {
    this.#io.ioCall(FS_TRUNCATE | FILE, handle.fd, { size });
  }

  stat(path: string, options?: { followSymlinks?: boolean }): FileStat {
    return this.#io.ioCall(FS_STAT | FILE, null, { path, options }) as FileStat;
  }

  readdir(path: string): DirEntry[] {
    return this.#io.ioCall(FS_READDIR | FILE, null, { path }) as DirEntry[];
  }

  mkdir(path: string): void {
    this.#io.ioCall(FS_MKDIR | FILE, null, { path });
  }

  unlink(path: string): void {
    this.#io.ioCall(FS_UNLINK | FILE, null, { path });
  }

  rmdir(path: string): void {
    this.#io.ioCall(FS_RMDIR | FILE, null, { path });
  }

  rename(oldPath: string, newPath: string): void {
    this.#io.ioCall(FS_RENAME | FILE, null, { oldPath, newPath });
  }

  symlink(target: string, linkPath: string): void {
    this.#io.ioCall(FS_SYMLINK | FILE, null, { target, linkPath });
  }

  readlink(path: string): string {
    return this.#io.ioCall(FS_READLINK | FILE, null, { path }) as string;
  }

  link(existingPath: string, newPath: string): void {
    this.#io.ioCall(FS_LINK | FILE, null, { existingPath, newPath });
  }

  chmod(path: string, mode: number): void {
    this.#io.ioCall(FS_CHMOD | FILE, null, { path, mode });
  }

  utimes(path: string, atime: Date, mtime: Date): void {
    this.#io.ioCall(FS_UTIMES | FILE, null, { path, atime: atime.getTime(), mtime: mtime.getTime() });
  }

  mkfifo(path: string): void {
    this.#io.ioCall(FS_MKFIFO | FILE, null, { path });
  }

  realpath(path: string): string {
    return this.#io.ioCall(FS_REALPATH | FILE, null, { path }) as string;
  }
}
