export * as network from './network.ts';
export * as instanceNetwork from './instance-network.ts';
export * as tcp from './tcp.ts';
export * as tcpCreateSocket from './tcp-create-socket.ts';
export * as udp from './udp.ts';
export * as udpCreateSocket from './udp-create-socket.ts';
export * as ipNameLookup from './ip-name-lookup.ts';
export type { SyncSocketProvider, SyncTcpSocket as IoTcpSocket, SyncUdpSocket as IoUdpSocket } from '@mithic/io/net';
export { DisabledSocketProvider } from '@mithic/io/net';

import type { SyncSocketProvider } from '@mithic/io/net';
import type { WasiSockets } from '../interfaces.ts';
import { Network } from './network.ts';
import { TcpSocket } from './tcp.ts';
import { UdpSocket } from './udp.ts';
import { ResolveAddressStream } from './ip-name-lookup.ts';
import type { IpAddressFamily, ErrorCode } from './network.ts';

export type { WasiSockets };

export function _createIsolatedSockets(provider: SyncSocketProvider): WasiSockets {
  return {
    network: { Network },
    instanceNetwork: {
      instanceNetwork(): Network { return new Network(); },
    },
    tcp: {
      TcpSocket,
    },
    tcpCreateSocket: {
      createTcpSocket(addressFamily: IpAddressFamily): TcpSocket {
        return new TcpSocket(addressFamily, provider);
      },
    },
    udp: {
      UdpSocket,
    },
    udpCreateSocket: {
      createUdpSocket(addressFamily: IpAddressFamily): UdpSocket {
        return new UdpSocket(addressFamily, provider);
      },
    },
    ipNameLookup: {
      ResolveAddressStream,
      resolveAddresses(_network: Network, name: string): ResolveAddressStream {
        if (!name || name.length === 0) {
          throw 'invalid-argument' as ErrorCode;
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) {
          throw 'invalid-argument' as ErrorCode;
        }
        return new ResolveAddressStream(name, provider);
      },
    },
  };
}
