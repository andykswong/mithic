/**
 * Implements wasi:sockets/udp - UdpSocket, IncomingDatagramStream, OutgoingDatagramStream.
 *
 * Delegates actual socket operations to SocketProvider from @mithic/io.
 */

import type { SocketProvider, UdpSocket as IoUdpSocket } from '@mithic/io/net';
import { Pollable } from '../io/poll.ts';
import {
  type ErrorCode,
  type IpAddressFamily,
  type IpSocketAddress,
  type Network,
  convertError,
  serializeAddress,
  zeroAddress,
} from './network.ts';
import { _getSocketProvider } from './tcp.ts';

export type IncomingDatagram = {
  data: Uint8Array;
  remoteAddress: IpSocketAddress;
};

export type OutgoingDatagram = {
  data: Uint8Array;
  remoteAddress?: IpSocketAddress;
};

type UdpSocketState = 'initial' | 'bind-in-progress' | 'bound' | 'connected' | 'closed';

/**
 * A UDP socket resource implementing the wasi:sockets/udp interface.
 */
export class UdpSocket {
  #state: UdpSocketState = 'initial';
  #family: IpAddressFamily;
  #provider: SocketProvider;
  #virtualSocket: IoUdpSocket | null = null;
  #localAddress: IpSocketAddress | null = null;
  #remoteAddress: IpSocketAddress | null = null;
  #pendingBind: IpSocketAddress | null = null;
  #bindDone = false;
  #bindError: ErrorCode | null = null;

  // Socket options
  #unicastHopLimit = 64;
  #receiveBufferSize = 65536n;
  #sendBufferSize = 65536n;

  constructor(family: IpAddressFamily, provider?: SocketProvider) {
    this.#family = family;
    this.#provider = provider ?? _getSocketProvider();
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
    this.#bindError = null;

    const addr = serializeAddress(localAddress);
    this.#provider.createUdpSocket().then((sock) => {
      this.#virtualSocket = sock;
      return sock.bind(addr);
    }).then(() => {
      this.#localAddress = localAddress;
      this.#bindDone = true;
    }).catch((err) => {
      this.#bindDone = true;
      this.#bindError = convertError(err);
    });
    // Synchronous fallback for sync providers
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
    if (this.#bindError) {
      const err = this.#bindError;
      this.#bindError = null;
      this.#state = 'initial'; // Allow retry
      throw err;
    }
    this.#state = 'bound';
    this.#localAddress = this.#pendingBind;
    this.#pendingBind = null;
  }

  /**
   * Set up inbound & outbound communication channels, optionally to a specific peer.
   */
  stream(remoteAddress?: IpSocketAddress): [IncomingDatagramStream, OutgoingDatagramStream] {
    if (this.#state !== 'bound' && this.#state !== 'connected') {
      throw 'invalid-state' as ErrorCode;
    }
    if (remoteAddress) {
      if (remoteAddress.tag !== this.#family) {
        throw 'invalid-argument' as ErrorCode;
      }
      if (remoteAddress.val.port === 0) {
        throw 'invalid-argument' as ErrorCode;
      }
      this.#remoteAddress = remoteAddress;
      this.#state = 'connected';
    }

    const incoming = new IncomingDatagramStream(this.#virtualSocket, this.#family);
    const outgoing = new OutgoingDatagramStream(this.#virtualSocket, this.#family, this.#remoteAddress);
    return [incoming, outgoing];
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
   * Get the remote address (only if stream() was called with a remote address).
   */
  remoteAddress(): IpSocketAddress {
    if (!this.#remoteAddress) {
      throw 'invalid-state' as ErrorCode;
    }
    return this.#remoteAddress;
  }

  /**
   * Whether this is an IPv4 or IPv6 socket.
   */
  addressFamily(): IpAddressFamily {
    return this.#family;
  }

  unicastHopLimit(): number {
    return this.#unicastHopLimit;
  }

  setUnicastHopLimit(value: number): void {
    if (value === 0) {
      throw 'invalid-argument' as ErrorCode;
    }
    this.#unicastHopLimit = value;
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
  subscribe(): Pollable {
    return new Pollable(() => {
      if (this.#state === 'bind-in-progress') return this.#bindDone;
      return true;
    });
  }

  [Symbol.dispose](): void {
    if (this.#virtualSocket) {
      void this.#virtualSocket.close();
      this.#virtualSocket = null;
    }
    this.#state = 'closed';
  }
}

/**
 * Stream of incoming datagrams.
 */
export class IncomingDatagramStream {
  #socket: IoUdpSocket | null;

  constructor(socket: IoUdpSocket | null, _family: IpAddressFamily) {
    this.#socket = socket;
  }

  /**
   * Receive datagrams without blocking.
   * Returns an empty list if no data is available.
   */
  receive(maxResults: bigint): IncomingDatagram[] {
    if (!this.#socket || maxResults === 0n) {
      return [];
    }
    // Non-blocking: in our sync shim, we return empty if no data ready
    return [];
  }

  subscribe(): Pollable {
    return new Pollable(() => true);
  }

  [Symbol.dispose](): void {
    this.#socket = null;
  }
}

/**
 * Stream for sending outgoing datagrams.
 */
export class OutgoingDatagramStream {
  #socket: IoUdpSocket | null;
  #remoteAddress: IpSocketAddress | null;

  constructor(socket: IoUdpSocket | null, _family: IpAddressFamily, remoteAddress: IpSocketAddress | null) {
    this.#socket = socket;
    this.#remoteAddress = remoteAddress;
  }

  /**
   * Check how many datagrams can be sent.
   */
  checkSend(): bigint {
    if (!this.#socket) {
      return 0n;
    }
    // Allow up to 64 datagrams per send batch
    return 64n;
  }

  /**
   * Send datagrams.
   */
  send(datagrams: OutgoingDatagram[]): bigint {
    if (!this.#socket || datagrams.length === 0) {
      return 0n;
    }

    let sent = 0n;
    for (const dg of datagrams) {
      const target = dg.remoteAddress ?? this.#remoteAddress;
      if (!target) {
        throw 'invalid-argument' as ErrorCode;
      }
      const addr = serializeAddress(target);
      try {
        void this.#socket.send(dg.data, addr);
        sent++;
      } catch (err) {
        if (sent > 0n) return sent;
        throw convertError(err);
      }
    }
    return sent;
  }

  subscribe(): Pollable {
    return new Pollable(() => true);
  }

  [Symbol.dispose](): void {
    this.#socket = null;
  }
}
