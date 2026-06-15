/**
 * Implements wasi:sockets/tcp - TcpSocket resource with full state machine.
 *
 * Delegates actual socket operations to SocketProvider from @mithic/io.
 * State machine is enforced per the WIT spec regardless of provider availability.
 */

import { type MaybePromise, isThenable } from '@mithic/io';
import type { SocketProvider, TcpSocket as IoTcpSocket } from '@mithic/io/net';
import { DisabledSocketProvider } from '@mithic/io/net';
import { InputStream, OutputStream } from '../io/streams.ts';
import type { InputStreamHandler, OutputStreamHandler } from '../io/streams.ts';
import { Pollable } from '../io/poll.ts';
import {
  type ErrorCode,
  type IpAddressFamily,
  type IpSocketAddress,
  type Network,
  convertError,
  parseIpAddress,
  serializeAddress,
  zeroAddress,
} from './network.ts';

export type ShutdownType = 'receive' | 'send' | 'both';

type TcpSocketState =
  | 'initial'
  | 'bind-in-progress'
  | 'bound'
  | 'listen-in-progress'
  | 'listening'
  | 'connect-in-progress'
  | 'connected'
  | 'closed';

/** Module-level socket provider. Set via _setSocketProvider. */
let _socketProvider: SocketProvider = new DisabledSocketProvider();

export function _setSocketProvider(provider: SocketProvider): void {
  _socketProvider = provider;
}

export function _getSocketProvider(): SocketProvider {
  return _socketProvider;
}

/** @deprecated Use _setSocketProvider instead. */
export function _setSyncSocketProvider(provider: SocketProvider): void {
  _socketProvider = provider;
}

/** @deprecated Use _getSocketProvider instead. */
export function _getSyncSocketProvider(): SocketProvider {
  return _socketProvider;
}

/**
 * A TCP socket resource implementing the wasi:sockets/tcp interface.
 */
export class TcpSocket<Sync extends boolean = boolean> {
  #state: TcpSocketState = 'initial';
  #family: IpAddressFamily;
  #provider: SocketProvider<Sync>;
  #virtualSocket: IoTcpSocket | null = null;
  #localAddress: IpSocketAddress | null = null;
  #remoteAddress: IpSocketAddress | null = null;
  #pendingBind: IpSocketAddress | null = null;
  #pendingConnect: IpSocketAddress | null = null;
  #bindDone = false;
  #connectDone = false;
  #connectError: ErrorCode | null = null;
  #listenDone = false;
  #listenError: ErrorCode | null = null;
  #inputStream: InputStream<Sync> | null = null;
  #outputStream: OutputStream<Sync> | null = null;
  #pendingPromise: Promise<void> | undefined;

  // Socket options (stored locally, applied when possible)
  #listenBacklogSize = 128;
  #keepAliveEnabled = false;
  #keepAliveIdleTime = 7_200_000_000_000n; // 2 hours in nanoseconds
  #keepAliveInterval = 75_000_000_000n; // 75s in nanoseconds
  #keepAliveCount = 9;
  #hopLimit = 64;
  #receiveBufferSize = 65536n;
  #sendBufferSize = 65536n;

  constructor(family: IpAddressFamily, provider?: SocketProvider<Sync>) {
    this.#family = family;
    this.#provider = provider ?? _socketProvider as SocketProvider<Sync>;
  }

  /**
   * Begin binding the socket to a local address.
   */
  startBind(_network: Network, localAddress: IpSocketAddress): void {
    if (this.#state !== 'initial') {
      throw 'invalid-state' as ErrorCode;
    }
    if (localAddress.tag !== this.#family) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#state = 'bind-in-progress';
    this.#pendingBind = localAddress;
    this.#bindDone = false;
    this.#connectError = null;

    const addr = serializeAddress(localAddress);
    try {
      const sockResult = this.#provider.createTcpSocket();
      if (sockResult instanceof Promise) {
        this.#pendingPromise = sockResult.then(sock => {
          this.#virtualSocket = sock;
          const bindResult = sock.bind(addr);
          if (bindResult instanceof Promise) {
            return bindResult.then(() => { this.#localAddress = localAddress; });
          }
          this.#localAddress = localAddress;
        }).then(() => {
          this.#bindDone = true;
        }).catch(err => {
          this.#connectError = convertError(err);
          this.#bindDone = true;
        });
        return;
      }
      this.#virtualSocket = sockResult;
      const bindResult = sockResult.bind(addr);
      if (bindResult instanceof Promise) {
        this.#pendingPromise = bindResult.then(() => {
          this.#localAddress = localAddress;
          this.#bindDone = true;
        }).catch(err => {
          this.#connectError = convertError(err);
          this.#bindDone = true;
        });
        return;
      }
      this.#localAddress = localAddress;
    } catch (err) {
      this.#connectError = convertError(err);
    }
    this.#bindDone = true;
  }

  /**
   * Complete the bind operation.
   */
  finishBind(): void {
    if (this.#state !== 'bind-in-progress') {
      throw 'not-in-progress' as ErrorCode;
    }
    if (!this.#bindDone) {
      throw 'would-block' as ErrorCode;
    }
    if (this.#connectError) {
      const err = this.#connectError;
      this.#connectError = null;
      this.#state = 'initial'; // Allow retry on bind failure
      throw err;
    }
    this.#state = 'bound';
    this.#localAddress = this.#pendingBind;
    this.#pendingBind = null;
    this.#applySocketOptions();
  }

  /**
   * Begin connecting to a remote address.
   */
  startConnect(_network: Network, remoteAddress: IpSocketAddress): void {
    if (this.#state !== 'initial' && this.#state !== 'bound') {
      throw 'invalid-state' as ErrorCode;
    }
    if (remoteAddress.tag !== this.#family) {
      throw 'invalid-argument' as ErrorCode;
    }
    if (remoteAddress.val.port === 0) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#state = 'connect-in-progress';
    this.#pendingConnect = remoteAddress;
    this.#connectDone = false;
    this.#connectError = null;

    const addr = serializeAddress(remoteAddress);

    const doConnect = (sock: IoTcpSocket): Promise<void> | undefined => {
      const connectResult = sock.connect(addr);
      if (connectResult instanceof Promise) {
        return connectResult.then(() => {
          this.#remoteAddress = remoteAddress;
          this.#connectDone = true;
        }).catch(err => {
          this.#connectError = convertError(err);
          this.#connectDone = true;
        });
      }
      this.#remoteAddress = remoteAddress;
      this.#connectDone = true;
      return undefined;
    };

    try {
      if (!this.#virtualSocket) {
        const sockResult = this.#provider.createTcpSocket();
        if (sockResult instanceof Promise) {
          this.#pendingPromise = sockResult.then(sock => {
            this.#virtualSocket = sock;
            return doConnect(sock);
          }).catch(err => {
            this.#connectError = convertError(err);
            this.#connectDone = true;
          });
          return;
        }
        this.#virtualSocket = sockResult;
      }
      this.#pendingPromise = doConnect(this.#virtualSocket);
    } catch (err) {
      this.#connectError = convertError(err);
      this.#connectDone = true;
    }
  }

  /**
   * Complete the connect operation, returning input and output streams.
   */
  finishConnect(): [InputStream<Sync>, OutputStream<Sync>] {
    if (this.#state !== 'connect-in-progress') {
      throw 'not-in-progress' as ErrorCode;
    }
    if (!this.#connectDone) {
      throw 'would-block' as ErrorCode;
    }
    if (this.#connectError) {
      const err = this.#connectError;
      this.#connectError = null;
      this.#state = 'closed';
      throw err;
    }
    this.#state = 'connected';
    this.#remoteAddress = this.#pendingConnect;
    this.#pendingConnect = null;
    this.#applySocketOptions();

    const sock = this.#virtualSocket;
    const inputHandler: InputStreamHandler<Sync> = {
      read(len: number): Uint8Array | undefined {
        if (!sock) return undefined;
        try {
          const result = sock.receive(len);
          if (isThenable(result)) return undefined;
          const data = result as Uint8Array;
          return data.byteLength > 0 ? data : undefined;
        } catch {
          return undefined;
        }
      },
      blockingRead(len: number): MaybePromise<Uint8Array, Sync> {
        if (!sock) throw { tag: 'closed' };
        try {
          const result = sock.receive(len);
          if (isThenable(result)) {
            return (result as Promise<Uint8Array>).then(
              data => { if (data.byteLength === 0) throw { tag: 'closed' }; return data; },
              () => { throw { tag: 'closed' }; },
            ) as MaybePromise<Uint8Array, Sync>;
          }
          const data = result as Uint8Array;
          if (data.byteLength === 0) throw { tag: 'closed' };
          return data;
        } catch (err) {
          if (err && typeof err === 'object' && 'tag' in err) throw err;
          throw { tag: 'closed' };
        }
      },
    };
    const outputHandler: OutputStreamHandler<Sync> = {
      write(data: Uint8Array): void {
        if (!sock) throw { tag: 'closed' };
        try {
          const result = sock.send(data);
          if (isThenable(result)) (result as Promise<unknown>).catch(() => {});
        } catch (err) {
          throw { tag: 'last-operation-failed', val: { toDebugString: () => String(err) } };
        }
      },
    };

    this.#inputStream = new InputStream<Sync>(inputHandler);
    this.#outputStream = new OutputStream<Sync>(outputHandler);
    return [this.#inputStream, this.#outputStream];
  }

  /**
   * Begin listening for connections.
   */
  startListen(): void {
    if (this.#state !== 'bound') {
      throw 'invalid-state' as ErrorCode;
    }
    this.#state = 'listen-in-progress';
    this.#listenDone = false;
    this.#listenError = null;

    if (!this.#virtualSocket) {
      this.#listenError = convertError(new Error('Socket not bound'));
      this.#listenDone = true;
      return;
    }

    try {
      const listenResult = this.#virtualSocket.listen(this.#listenBacklogSize);
      if (listenResult instanceof Promise) {
        this.#pendingPromise = listenResult.then(() => {
          this.#listenDone = true;
        }).catch(err => {
          this.#listenError = convertError(err);
          this.#listenDone = true;
        });
        return;
      }
    } catch (err) {
      this.#listenError = convertError(err);
    }
    this.#listenDone = true;
  }

  /**
   * Complete the listen operation.
   */
  finishListen(): void {
    if (this.#state !== 'listen-in-progress') {
      throw 'not-in-progress' as ErrorCode;
    }
    if (!this.#listenDone) {
      throw 'would-block' as ErrorCode;
    }
    if (this.#listenError) {
      const err = this.#listenError;
      this.#listenError = null;
      this.#state = 'closed';
      throw err;
    }
    this.#state = 'listening';
  }

  /**
   * Accept a new client connection.
   * If the provider's accept() returns a Promise, this throws 'would-block'
   * (the caller should poll and retry).
   */
  accept(): [TcpSocket<Sync>, InputStream<Sync>, OutputStream<Sync>] {
    if (this.#state !== 'listening') {
      throw 'invalid-state' as ErrorCode;
    }
    if (!this.#virtualSocket) {
      throw 'would-block' as ErrorCode;
    }

    let acceptedSocket: IoTcpSocket | null = null;

    try {
      const result = this.#virtualSocket.accept();
      if (result instanceof Promise) {
        throw 'would-block' as ErrorCode;
      }
      acceptedSocket = result;
    } catch (err) {
      if (err === 'would-block') throw err;
      throw convertError(err);
    }

    if (!acceptedSocket) {
      throw 'would-block' as ErrorCode;
    }

    const clientTcp = new TcpSocket<Sync>(this.#family, this.#provider);
    clientTcp.#state = 'connected';
    clientTcp.#virtualSocket = acceptedSocket;
    clientTcp.#localAddress = this.#localAddress;

    const remoteSock = acceptedSocket;
    const remote = remoteSock.remoteAddress();
    if (remote) {
      const ipAddr = parseIpAddress(remote.host, this.#family === 'ipv4' ? 'ipv4' : 'ipv6');
      if (ipAddr.tag === 'ipv4') {
        clientTcp.#remoteAddress = { tag: 'ipv4', val: { port: remote.port, address: ipAddr.val } };
      } else {
        clientTcp.#remoteAddress = { tag: 'ipv6', val: { port: remote.port, flowInfo: 0, address: ipAddr.val, scopeId: 0 } };
      }
    }

    const inputHandler: InputStreamHandler<Sync> = {
      read(len: number): Uint8Array | undefined {
        try {
          const result = remoteSock.receive(len);
          if (isThenable(result)) return undefined;
          const data = result as Uint8Array;
          return data.byteLength > 0 ? data : undefined;
        } catch {
          return undefined;
        }
      },
      blockingRead(len: number): MaybePromise<Uint8Array, Sync> {
        try {
          const result = remoteSock.receive(len);
          if (isThenable(result)) {
            return (result as Promise<Uint8Array>).then(
              data => { if (data.byteLength === 0) throw { tag: 'closed' }; return data; },
              () => { throw { tag: 'closed' }; },
            ) as MaybePromise<Uint8Array, Sync>;
          }
          const data = result as Uint8Array;
          if (data.byteLength === 0) throw { tag: 'closed' };
          return data;
        } catch (err) {
          if (err && typeof err === 'object' && 'tag' in err) throw err;
          throw { tag: 'closed' };
        }
      },
    };
    const outputHandler: OutputStreamHandler<Sync> = {
      write(data: Uint8Array): void {
        try {
          const result = remoteSock.send(data);
          if (isThenable(result)) (result as Promise<unknown>).catch(() => {});
        } catch (err) {
          throw { tag: 'last-operation-failed', val: { toDebugString: () => String(err) } };
        }
      },
    };

    const inputStream = new InputStream<Sync>(inputHandler);
    const outputStream = new OutputStream<Sync>(outputHandler);
    return [clientTcp, inputStream, outputStream];
  }

  #applySocketOptions(): void {
    if (this.#virtualSocket?.setSocketOptions) {
      void this.#virtualSocket.setSocketOptions({
        keepAliveEnabled: this.#keepAliveEnabled,
        keepAliveIdleTime: Number(this.#keepAliveIdleTime / 1_000_000n), // ns → ms
        hopLimit: this.#hopLimit,
        receiveBufferSize: Number(this.#receiveBufferSize),
        sendBufferSize: Number(this.#sendBufferSize),
      });
    }
  }

  /**
   * Initiate a graceful shutdown.
   */
  shutdown(shutdownType: ShutdownType): void {
    if (this.#state !== 'connected') {
      throw 'invalid-state' as ErrorCode;
    }
    if (this.#virtualSocket) {
      void this.#virtualSocket.shutdown(shutdownType);
    }
  }

  /**
   * Get the bound local address.
   */
  localAddress(): IpSocketAddress {
    if (this.#state === 'initial') {
      throw 'invalid-state' as ErrorCode;
    }
    if (this.#localAddress) {
      return this.#localAddress;
    }
    if (this.#virtualSocket) {
      const local = this.#virtualSocket.localAddress();
      if (local) {
        if (this.#family === 'ipv4') {
          const parts = local.host.split('.').map(Number) as [number, number, number, number];
          return { tag: 'ipv4', val: { port: local.port, address: parts } };
        } else {
          const parts = local.host.split(':').map(s => parseInt(s, 16) || 0);
          while (parts.length < 8) parts.push(0);
          return {
            tag: 'ipv6',
            val: { port: local.port, flowInfo: 0, address: parts.slice(0, 8) as [number, number, number, number, number, number, number, number], scopeId: 0 },
          };
        }
      }
    }
    return zeroAddress(this.#family);
  }

  /**
   * Get the connected remote address.
   */
  remoteAddress(): IpSocketAddress {
    if (this.#state !== 'connected') {
      throw 'invalid-state' as ErrorCode;
    }
    if (this.#remoteAddress) {
      return this.#remoteAddress;
    }
    throw 'invalid-state' as ErrorCode;
  }

  /**
   * Whether the socket is in the listening state.
   */
  isListening(): boolean {
    return this.#state === 'listening';
  }

  /**
   * Whether this is an IPv4 or IPv6 socket.
   */
  addressFamily(): IpAddressFamily {
    return this.#family;
  }

  /**
   * Set the listen backlog size.
   */
  setListenBacklogSize(value: bigint): void {
    if (value === 0n) {
      throw 'invalid-argument' as ErrorCode;
    }
    if (this.#state === 'listening' || this.#state === 'listen-in-progress') {
      throw 'not-supported' as ErrorCode;
    }
    if (this.#state === 'connect-in-progress' || this.#state === 'connected') {
      throw 'invalid-state' as ErrorCode;
    }
    this.#listenBacklogSize = Number(value);
  }

  keepAliveEnabled(): boolean {
    return this.#keepAliveEnabled;
  }

  setKeepAliveEnabled(value: boolean): void {
    this.#keepAliveEnabled = value;
  }

  keepAliveIdleTime(): bigint {
    return this.#keepAliveIdleTime;
  }

  setKeepAliveIdleTime(value: bigint): void {
    if (value === 0n) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#keepAliveIdleTime = value;
  }

  keepAliveInterval(): bigint {
    return this.#keepAliveInterval;
  }

  setKeepAliveInterval(value: bigint): void {
    if (value === 0n) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#keepAliveInterval = value;
  }

  keepAliveCount(): number {
    return this.#keepAliveCount;
  }

  setKeepAliveCount(value: number): void {
    if (value === 0) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#keepAliveCount = value;
  }

  hopLimit(): number {
    return this.#hopLimit;
  }

  setHopLimit(value: number): void {
    if (value === 0) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#hopLimit = value;
  }

  receiveBufferSize(): bigint {
    return this.#receiveBufferSize;
  }

  setReceiveBufferSize(value: bigint): void {
    if (value === 0n) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#receiveBufferSize = value;
  }

  sendBufferSize(): bigint {
    return this.#sendBufferSize;
  }

  setSendBufferSize(value: bigint): void {
    if (value === 0n) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#sendBufferSize = value;
  }

  /**
   * Create a pollable for this socket.
   */
  subscribe(): Pollable<Sync> {
    const pendingPromise = this.#pendingPromise;
    return new Pollable<Sync>(
      () => {
        if (this.#state === 'bind-in-progress') return this.#bindDone;
        if (this.#state === 'connect-in-progress') return this.#connectDone;
        if (this.#state === 'listen-in-progress') return this.#listenDone;
        return true;
      },
      (_maxBlockMs?) => {
        if (this.#state === 'bind-in-progress' && this.#bindDone) return;
        if (this.#state === 'connect-in-progress' && this.#connectDone) return;
        if (this.#state === 'listen-in-progress' && this.#listenDone) return;
        if (this.#state !== 'bind-in-progress' && this.#state !== 'connect-in-progress' && this.#state !== 'listen-in-progress') return;
        return pendingPromise as MaybePromise<void, Sync>;
      },
    );
  }

  [Symbol.dispose](): void {
    if (this.#virtualSocket) {
      void this.#virtualSocket.close();
      this.#virtualSocket = null;
    }
    this.#state = 'closed';
  }
}
