/**
 * Typed interfaces for WASIShim isolated module namespaces.
 * These describe the shape of each WASI interface object in the import map.
 */

import type { Descriptor } from './filesystem/types.ts';
import type { InputStream, OutputStream } from './io/streams.ts';
import type { OutgoingRequest, RequestOptions, FutureIncomingResponse } from './http/types.ts';
import type { TcpSocket, ShutdownType } from './sockets/tcp.ts';
import type { UdpSocket } from './sockets/udp.ts';
import type { Network, IpAddressFamily } from './sockets/network.ts';
import type { ResolveAddressStream } from './sockets/ip-name-lookup.ts';

export interface WasiEnvironment {
  getEnvironment(): [string, string][];
  getArguments(): string[];
  initialCwd(): string;
}

export interface WasiPreopens {
  Descriptor: typeof Descriptor;
  getDirectories(): [Descriptor, string][];
}

export interface WasiStdin {
  InputStream: typeof InputStream;
  getStdin(): InputStream;
}

export interface WasiStdout {
  OutputStream: typeof OutputStream;
  getStdout(): OutputStream;
}

export interface WasiStderr {
  OutputStream: typeof OutputStream;
  getStderr(): OutputStream;
}

export interface WasiOutgoingHandler {
  handle(request: OutgoingRequest, options?: RequestOptions): FutureIncomingResponse;
}

export interface WasiSockets {
  network: WasiNetwork;
  instanceNetwork: WasiInstanceNetwork;
  tcp: WasiTcp;
  tcpCreateSocket: WasiTcpCreateSocket;
  udp: WasiUdp;
  udpCreateSocket: WasiUdpCreateSocket;
  ipNameLookup: WasiIpNameLookup;
}

export interface WasiNetwork {
  Network: typeof Network;
}

export interface WasiInstanceNetwork {
  instanceNetwork(): Network;
}

export interface WasiTcp {
  TcpSocket: typeof TcpSocket;
  ShutdownType?: ShutdownType;
}

export interface WasiTcpCreateSocket {
  createTcpSocket(addressFamily: IpAddressFamily): TcpSocket;
}

export interface WasiUdp {
  UdpSocket: typeof UdpSocket;
}

export interface WasiUdpCreateSocket {
  createUdpSocket(addressFamily: IpAddressFamily): UdpSocket;
}

export interface WasiIpNameLookup {
  ResolveAddressStream: typeof ResolveAddressStream;
  resolveAddresses(network: Network, name: string): ResolveAddressStream;
}
