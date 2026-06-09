import * as net from 'node:net';
import * as dgram from 'node:dgram';
import * as dns from 'node:dns/promises';
import type { SocketProvider, TcpSocket, UdpSocket, SocketAddress, IpAddress, SocketOptions } from '../sockets.ts';

export class NodeSocketProvider implements SocketProvider {
  async createTcpSocket(): Promise<TcpSocket> {
    return new NativeTcpSocket();
  }

  async createUdpSocket(): Promise<UdpSocket> {
    return new NativeUdpSocket();
  }

  async resolveName(name: string): Promise<IpAddress[]> {
    const results = await dns.lookup(name, { all: true, family: 0 });
    return results.map(r => ({
      family: (r.family === 6 ? 'ipv6' : 'ipv4') as 'ipv4' | 'ipv6',
      address: r.address,
    }));
  }
}

class NativeTcpSocket implements TcpSocket {
  #socket: net.Socket;
  #server: net.Server | null = null;
  #localAddr: SocketAddress | undefined;
  #remoteAddr: SocketAddress | undefined;
  #pendingData: Buffer[] = [];

  constructor(socket?: net.Socket) {
    this.#socket = socket ?? new net.Socket();
    if (socket) {
      this.#localAddr = {
        host: socket.localAddress ?? '0.0.0.0',
        port: socket.localPort ?? 0,
      };
      this.#remoteAddr = {
        host: socket.remoteAddress ?? '0.0.0.0',
        port: socket.remotePort ?? 0,
      };
    }
  }

  async bind(address: SocketAddress): Promise<void> {
    this.#localAddr = address;
  }

  async connect(address: SocketAddress): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.#socket.off('error', onError);
        reject(err);
      };
      this.#socket.once('error', onError);
      this.#socket.connect(address.port, address.host, () => {
        this.#socket.off('error', onError);
        this.#remoteAddr = address;
        this.#localAddr = {
          host: this.#socket.localAddress ?? '0.0.0.0',
          port: this.#socket.localPort ?? 0,
        };
        resolve();
      });
    });
  }

  async listen(backlog?: number): Promise<void> {
    this.#server = net.createServer();
    return new Promise((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(
        this.#localAddr?.port ?? 0,
        this.#localAddr?.host ?? '0.0.0.0',
        backlog,
        () => {
          this.#server!.off('error', reject);
          const addr = this.#server!.address();
          if (addr && typeof addr === 'object') {
            this.#localAddr = { host: addr.address, port: addr.port };
          }
          resolve();
        }
      );
    });
  }

  async accept(): Promise<TcpSocket> {
    return new Promise((resolve) => {
      this.#server!.once('connection', (socket) => {
        const accepted = new NativeTcpSocket(socket);
        resolve(accepted);
      });
    });
  }

  async send(data: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#socket.write(data, (err) => {
        if (err) reject(err);
        else resolve(data.byteLength);
      });
    });
  }

  async receive(len: number): Promise<Uint8Array> {
    // Check if there's already buffered data in the internal buffer
    if (this.#pendingData.length > 0) {
      return this.#consumeBuffer(len);
    }
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.#pendingData.push(chunk);
        cleanup();
        resolve(this.#consumeBuffer(len));
      };
      const onEnd = () => {
        cleanup();
        resolve(new Uint8Array(0));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.#socket.off('data', onData);
        this.#socket.off('end', onEnd);
        this.#socket.off('error', onError);
      };
      this.#socket.once('data', onData);
      this.#socket.once('end', onEnd);
      this.#socket.once('error', onError);
    });
  }

  #consumeBuffer(len: number): Uint8Array {
    const total = Buffer.concat(this.#pendingData);
    this.#pendingData = [];
    const slice = total.subarray(0, len);
    if (total.byteLength > len) {
      this.#pendingData.push(total.subarray(len));
    }
    return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
  }

  async shutdown(type?: 'receive' | 'send' | 'both'): Promise<void> {
    const shutdownType = type ?? 'both';
    if (shutdownType === 'receive') {
      this.#socket.pause();
      this.#socket.removeAllListeners('data');
      return;
    }
    if (shutdownType === 'send') {
      return new Promise((resolve) => {
        this.#socket.end(() => resolve());
      });
    }
    // 'both'
    this.#socket.destroy();
  }

  async setSocketOptions(options: SocketOptions): Promise<void> {
    if (options.keepAliveEnabled !== undefined) {
      this.#socket.setKeepAlive(options.keepAliveEnabled, options.keepAliveIdleTime);
    }
    if (options.hopLimit !== undefined) {
      try {
        (this.#socket as unknown as { setTTL(ttl: number): void }).setTTL(options.hopLimit);
      } catch { /* TTL not supported on all platforms */ }
    }
  }

  async close(): Promise<void> {
    this.#socket.destroy();
    if (this.#server) {
      await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
      this.#server = null;
    }
  }

  localAddress(): SocketAddress | undefined {
    return this.#localAddr;
  }

  remoteAddress(): SocketAddress | undefined {
    return this.#remoteAddr;
  }
}

class NativeUdpSocket implements UdpSocket {
  #socket: dgram.Socket;
  #localAddr: SocketAddress | undefined;

  constructor() {
    this.#socket = dgram.createSocket('udp4');
  }

  async bind(address: SocketAddress): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.once('error', reject);
      this.#socket.bind(address.port, address.host, () => {
        this.#socket.off('error', reject);
        const addr = this.#socket.address();
        this.#localAddr = { host: addr.address, port: addr.port };
        resolve();
      });
    });
  }

  async send(data: Uint8Array, remoteAddress: SocketAddress): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#socket.send(data, remoteAddress.port, remoteAddress.host, (err) => {
        if (err) reject(err);
        else resolve(data.byteLength);
      });
    });
  }

  async receive(len: number): Promise<{ data: Uint8Array; remoteAddress: SocketAddress }> {
    return new Promise((resolve) => {
      this.#socket.once('message', (msg, rinfo) => {
        resolve({
          data: new Uint8Array(msg.buffer, msg.byteOffset, Math.min(msg.byteLength, len)),
          remoteAddress: { host: rinfo.address, port: rinfo.port },
        });
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.#socket.close(() => resolve());
    });
  }

  localAddress(): SocketAddress | undefined {
    return this.#localAddr;
  }
}
