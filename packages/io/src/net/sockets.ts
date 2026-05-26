import type { MaybePromise } from '../types.ts';

export interface SocketAddress {
  host: string;
  port: number;
}

export interface IpAddress {
  family: 'ipv4' | 'ipv6';
  address: string;
}

export interface TcpSocket {
  bind(address: SocketAddress): MaybePromise<void>;
  connect(address: SocketAddress): MaybePromise<void>;
  listen(backlog?: number): MaybePromise<void>;
  accept(): MaybePromise<TcpSocket>;
  send(data: Uint8Array): MaybePromise<number>;
  receive(len: number): MaybePromise<Uint8Array>;
  shutdown(): MaybePromise<void>;
  close(): MaybePromise<void>;
  localAddress(): SocketAddress | undefined;
  remoteAddress(): SocketAddress | undefined;
}

export interface SyncTcpSocket extends TcpSocket {
  bind(address: SocketAddress): void;
  connect(address: SocketAddress): void;
  listen(backlog?: number): void;
  accept(): SyncTcpSocket;
  send(data: Uint8Array): number;
  receive(len: number): Uint8Array;
  shutdown(): void;
  close(): void;
}

export interface UdpSocket {
  bind(address: SocketAddress): MaybePromise<void>;
  send(data: Uint8Array, remoteAddress: SocketAddress): MaybePromise<number>;
  receive(len: number): MaybePromise<{ data: Uint8Array; remoteAddress: SocketAddress }>;
  close(): MaybePromise<void>;
  localAddress(): SocketAddress | undefined;
}

export interface SyncUdpSocket extends UdpSocket {
  bind(address: SocketAddress): void;
  send(data: Uint8Array, remoteAddress: SocketAddress): number;
  receive(len: number): { data: Uint8Array; remoteAddress: SocketAddress };
  close(): void;
}

export interface SocketProvider {
  createTcpSocket(): MaybePromise<TcpSocket>;
  createUdpSocket(): MaybePromise<UdpSocket>;
  resolveName(name: string): MaybePromise<IpAddress[]>;
  dispose?(): void;
}

export interface SyncSocketProvider extends SocketProvider {
  createTcpSocket(): SyncTcpSocket;
  createUdpSocket(): SyncUdpSocket;
  resolveName(name: string): IpAddress[];
}

/** Socket provider that always throws (for sandboxed environments). */
export class DisabledSocketProvider implements SocketProvider {
  createTcpSocket(): TcpSocket {
    throw new Error('Socket access is disabled');
  }
  createUdpSocket(): UdpSocket {
    throw new Error('Socket access is disabled');
  }
  resolveName(_name: string): IpAddress[] {
    throw new Error('DNS resolution is disabled');
  }
}
