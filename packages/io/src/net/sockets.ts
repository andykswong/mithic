import type { MaybePromise } from '../types.ts';

export interface SocketAddress {
  host: string;
  port: number;
}

export interface IpAddress {
  family: 'ipv4' | 'ipv6';
  address: string;
}

export interface SocketOptions {
  keepAliveEnabled?: boolean;
  keepAliveIdleTime?: number; // milliseconds
  hopLimit?: number;
  receiveBufferSize?: number;
  sendBufferSize?: number;
}

export interface TcpSocket<Sync extends boolean = boolean> {
  bind(address: SocketAddress): MaybePromise<void, Sync>;
  connect(address: SocketAddress): MaybePromise<void, Sync>;
  listen(backlog?: number): MaybePromise<void, Sync>;
  accept(): MaybePromise<TcpSocket<Sync>, Sync>;
  send(data: Uint8Array): MaybePromise<number, Sync>;
  receive(len: number): MaybePromise<Uint8Array, Sync>;
  shutdown(type?: 'receive' | 'send' | 'both'): MaybePromise<void, Sync>;
  close(): MaybePromise<void, Sync>;
  localAddress(): SocketAddress | undefined;
  remoteAddress(): SocketAddress | undefined;
  setSocketOptions?(options: SocketOptions): MaybePromise<void, Sync>;
}

export type SyncTcpSocket = TcpSocket<true>;

export interface UdpSocket<Sync extends boolean = boolean> {
  bind(address: SocketAddress): MaybePromise<void, Sync>;
  send(data: Uint8Array, remoteAddress: SocketAddress): MaybePromise<number, Sync>;
  receive(len: number): MaybePromise<{ data: Uint8Array; remoteAddress: SocketAddress }, Sync>;
  close(): MaybePromise<void, Sync>;
  localAddress(): SocketAddress | undefined;
}

export type SyncUdpSocket = UdpSocket<true>;

export interface SocketProvider<Sync extends boolean = boolean> {
  createTcpSocket(): MaybePromise<TcpSocket<Sync>, Sync>;
  createUdpSocket(): MaybePromise<UdpSocket<Sync>, Sync>;
  resolveName(name: string): MaybePromise<IpAddress[], Sync>;
  dispose?(): void;
}

export type SyncSocketProvider = SocketProvider<true>;

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
