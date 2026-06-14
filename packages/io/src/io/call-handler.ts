/**
 * Unified I/O call handler for the IoLoop.
 *
 * Dispatches FS/HTTP/socket/stream/poll calls to the appropriate providers.
 * Maintains handle tables for open file descriptors and streams.
 */

import type { FileSystemProvider } from '../vfs/provider.ts';
import type { SocketAddress, SocketProvider, TcpSocket, UdpSocket } from '../net/sockets.ts';
import type { HttpClient, HttpRequest } from '../net/http.ts';
import type { FileHandle, OpenFlags } from '../vfs/provider.ts';
import type { CallHandler } from './sync-bridge.ts';
import type { InputStreamHandler, OutputStreamHandler } from './streams.ts';
import {
  CALL_MASK, TYPE_MASK,
  STDIN, STDOUT, STDERR, SOCKET_UDP,
  INPUT_STREAM_READ, INPUT_STREAM_BLOCKING_READ, INPUT_STREAM_DISPOSE,
  OUTPUT_STREAM_WRITE, OUTPUT_STREAM_FLUSH, OUTPUT_STREAM_DISPOSE,
  FS_OPEN, FS_CLOSE, FS_READ, FS_WRITE, FS_STAT, FS_READDIR,
  FS_MKDIR, FS_UNLINK, FS_RMDIR, FS_RENAME, FS_SYMLINK, FS_READLINK,
  FS_CHMOD, FS_UTIMES, FS_TRUNCATE, FS_LINK, FS_REALPATH, FS_MKFIFO,
  HTTP_SEND,
  SOCKET_CREATE, SOCKET_BIND, SOCKET_CONNECT, SOCKET_LISTEN,
  SOCKET_ACCEPT, SOCKET_SEND, SOCKET_RECV, SOCKET_CLOSE, SOCKET_RESOLVE,
} from './calls.ts';

export interface CallHandlerOptions {
  fs?: FileSystemProvider;
  http?: HttpClient;
  sockets?: SocketProvider;
  stdin?: InputStreamHandler;
  stdout?: OutputStreamHandler;
  stderr?: OutputStreamHandler;
}

interface StreamHandle {
  read?(len: number): Promise<Uint8Array>;
  write?(data: Uint8Array): Promise<void>;
  flush?(): Promise<void>;
}

/**
 * Creates a CallHandler that dispatches I/O calls to providers.
 */
export function createCallHandler(options: CallHandlerOptions): CallHandler {
  const { fs, http, sockets } = options;
  const fileHandles = new Map<number, FileHandle>();
  const streamHandles = new Map<number, StreamHandle>();
  const socketHandles = new Map<number, TcpSocket>();
  const udpHandles = new Map<number, UdpSocket>();
  let nextHandleId = 1;

  function requireFs(): FileSystemProvider {
    if (!fs) throw new Error('No filesystem provider configured');
    return fs;
  }

  function requireHttp(): HttpClient {
    if (!http) throw new Error('No HTTP provider configured');
    return http;
  }

  function requireSockets(): SocketProvider {
    if (!sockets) throw new Error('No socket provider configured');
    return sockets;
  }

  function allocId(): number {
    return nextHandleId++;
  }

  function requireId(id: number | null): number {
    if (id === null || id === undefined) throw new Error('missing resource handle id');
    return id;
  }

  function getSocket(id: number | null): TcpSocket {
    const socket = socketHandles.get(requireId(id));
    if (!socket) throw new Error('invalid socket handle');
    return socket;
  }

  function getFileHandle(id: number | null): FileHandle {
    const handle = fileHandles.get(requireId(id));
    if (!handle) throw new Error('invalid file handle');
    return handle;
  }

  return async (call: number, id: number | null, payload: unknown): Promise<unknown> => {
    const method = call & CALL_MASK;
    const resourceType = call & TYPE_MASK;

    switch (method) {
      // ─── Stream calls ───────────────────────────────────────────────
      case INPUT_STREAM_READ:
      case INPUT_STREAM_BLOCKING_READ: {
        const { len } = payload as { len: number };
        if (resourceType === STDIN && options.stdin) {
          if (method === INPUT_STREAM_READ && options.stdin.read) {
            const data = await options.stdin.read(len);
            return data ?? new Uint8Array(0);
          }
          return options.stdin.blockingRead(len);
        }
        const stream = streamHandles.get(requireId(id));
        return stream?.read ? stream.read(len) : new Uint8Array(0);
      }

      case OUTPUT_STREAM_WRITE: {
        const { data } = payload as { data: Uint8Array };
        if (resourceType === STDOUT && options.stdout) return options.stdout.write(data);
        if (resourceType === STDERR && options.stderr) return options.stderr.write(data);
        const stream = streamHandles.get(requireId(id));
        if (stream?.write) await stream.write(data);
        return;
      }

      case OUTPUT_STREAM_FLUSH: {
        if (resourceType === STDOUT || resourceType === STDERR) return;
        const stream = streamHandles.get(requireId(id));
        if (stream?.flush) await stream.flush();
        return;
      }

      case INPUT_STREAM_DISPOSE:
      case OUTPUT_STREAM_DISPOSE:
        if (resourceType === STDIN || resourceType === STDOUT || resourceType === STDERR) return;
        streamHandles.delete(requireId(id));
        return;

      // ─── Filesystem calls ───────────────────────────────────────────
      case FS_OPEN: {
        const { path, flags } = payload as { path: string; flags: OpenFlags };
        const handle = await requireFs().open(path, flags);
        const handleId = allocId();
        fileHandles.set(handleId, handle);
        return handleId;
      }

      case FS_CLOSE: {
        const handle = fileHandles.get(requireId(id));
        if (handle) {
          await requireFs().close(handle);
          fileHandles.delete(requireId(id));
        }
        return;
      }

      case FS_READ: {
        const { offset, len } = payload as { offset: number; len: number };
        return requireFs().read(getFileHandle(id), offset, len);
      }

      case FS_WRITE: {
        const { data, offset } = payload as { data: Uint8Array; offset: number };
        return requireFs().write(getFileHandle(id), data, offset);
      }

      case FS_TRUNCATE: {
        const { size } = payload as { size: number };
        return requireFs().truncate(getFileHandle(id), size);
      }

      case FS_STAT: {
        const { path, options: statOpts } = payload as { path: string; options?: { followSymlinks?: boolean } };
        return requireFs().stat(path, statOpts);
      }

      case FS_READDIR:
        return requireFs().readdir((payload as { path: string }).path);

      case FS_MKDIR:
        return requireFs().mkdir((payload as { path: string }).path);

      case FS_UNLINK:
        return requireFs().unlink((payload as { path: string }).path);

      case FS_RMDIR:
        return requireFs().rmdir((payload as { path: string }).path);

      case FS_RENAME: {
        const { oldPath, newPath } = payload as { oldPath: string; newPath: string };
        return requireFs().rename(oldPath, newPath);
      }

      case FS_SYMLINK: {
        const { target, linkPath } = payload as { target: string; linkPath: string };
        return requireFs().symlink(target, linkPath);
      }

      case FS_READLINK:
        return requireFs().readlink((payload as { path: string }).path);

      case FS_CHMOD: {
        const { path, mode } = payload as { path: string; mode: number };
        return requireFs().chmod(path, mode);
      }

      case FS_UTIMES: {
        const { path, atime, mtime } = payload as { path: string; atime: number; mtime: number };
        return requireFs().utimes(path, new Date(atime), new Date(mtime));
      }

      case FS_LINK: {
        const { existingPath, newPath } = payload as { existingPath: string; newPath: string };
        return requireFs().link(existingPath, newPath);
      }

      case FS_REALPATH: {
        const fsp = requireFs();
        return fsp.realpath ? fsp.realpath((payload as { path: string }).path) : (payload as { path: string }).path;
      }

      case FS_MKFIFO: {
        return requireFs().mkfifo((payload as { path: string }).path);
      }

      // ─── HTTP calls ─────────────────────────────────────────────────
      case HTTP_SEND:
        return requireHttp().send(payload as HttpRequest);

      // ─── Socket calls ───────────────────────────────────────────────
      case SOCKET_CREATE: {
        if (resourceType === SOCKET_UDP) {
          const udpSocket = await requireSockets().createUdpSocket();
          const udpId = allocId();
          udpHandles.set(udpId, udpSocket);
          return udpId;
        }
        const socket = await requireSockets().createTcpSocket();
        const socketId = allocId();
        socketHandles.set(socketId, socket);
        return socketId;
      }

      case SOCKET_BIND: {
        if (resourceType === SOCKET_UDP) {
          const udp = udpHandles.get(requireId(id));
          if (!udp) throw new Error('invalid UDP socket handle');
          await udp.bind((payload as { address: SocketAddress }).address);
          return;
        }
        await getSocket(id).bind((payload as { address: SocketAddress }).address);
        return;
      }

      case SOCKET_CONNECT:
        await getSocket(id).connect((payload as { address: SocketAddress }).address);
        return;

      case SOCKET_LISTEN:
        await getSocket(id).listen((payload as { backlog?: number }).backlog);
        return;

      case SOCKET_ACCEPT: {
        const accepted = await getSocket(id).accept();
        const acceptedId = allocId();
        socketHandles.set(acceptedId, accepted);
        return acceptedId;
      }

      case SOCKET_SEND: {
        if (resourceType === SOCKET_UDP) {
          const udp = udpHandles.get(requireId(id));
          if (!udp) throw new Error('invalid UDP socket handle');
          const { data, remoteAddress } = payload as { data: Uint8Array; remoteAddress: SocketAddress };
          return udp.send(data, remoteAddress);
        }
        return getSocket(id).send((payload as { data: Uint8Array }).data);
      }

      case SOCKET_RECV: {
        if (resourceType === SOCKET_UDP) {
          const udp = udpHandles.get(requireId(id));
          if (!udp) throw new Error('invalid UDP socket handle');
          return udp.receive((payload as { len: number }).len);
        }
        return getSocket(id).receive((payload as { len: number }).len);
      }

      case SOCKET_CLOSE: {
        if (resourceType === SOCKET_UDP) {
          const udp = udpHandles.get(requireId(id));
          if (udp) {
            await udp.close();
            udpHandles.delete(requireId(id));
          }
          return;
        }
        const socket = socketHandles.get(requireId(id));
        if (socket) {
          await socket.close();
          socketHandles.delete(requireId(id));
        }
        return;
      }

      case SOCKET_RESOLVE:
        return requireSockets().resolveName((payload as { name: string }).name);

      default:
        throw new Error(`unknown call: method=0x${method.toString(16)}, type=0x${resourceType.toString(16)}`);
    }
  };
}
