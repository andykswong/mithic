export interface SocketAddress {
  host: string;
  port: number;
}

export interface IpAddress {
  family: 'ipv4' | 'ipv6';
  address: string;
}

export interface TcpSocket {
  bind(address: SocketAddress): Promise<void>;
  connect(address: SocketAddress): Promise<void>;
  listen(backlog?: number): Promise<void>;
  accept(): Promise<TcpSocket>;
  send(data: Uint8Array): Promise<number>;
  receive(len: number): Promise<Uint8Array>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
  localAddress(): SocketAddress | undefined;
  remoteAddress(): SocketAddress | undefined;
}

export interface UdpSocket {
  bind(address: SocketAddress): Promise<void>;
  send(data: Uint8Array, remoteAddress: SocketAddress): Promise<number>;
  receive(len: number): Promise<{ data: Uint8Array; remoteAddress: SocketAddress }>;
  close(): Promise<void>;
  localAddress(): SocketAddress | undefined;
}

export interface SocketProvider {
  createTcpSocket(): Promise<TcpSocket>;
  createUdpSocket(): Promise<UdpSocket>;
  resolveName(name: string): Promise<IpAddress[]>;
  dispose?(): void;
}

/** Socket provider that always throws (for sandboxed environments). */
export class DisabledSocketProvider implements SocketProvider {
  async createTcpSocket(): Promise<TcpSocket> {
    throw new Error('Socket access is disabled');
  }
  async createUdpSocket(): Promise<UdpSocket> {
    throw new Error('Socket access is disabled');
  }
  async resolveName(_name: string): Promise<IpAddress[]> {
    throw new Error('DNS resolution is disabled');
  }
}
