import { MemoryFsProvider, DeviceFsProvider, NetworkDeviceFsProvider, FileSystemRouter } from '@mithic/io/vfs';
import type { SocketProvider } from '@mithic/io/net';
import { NodeFsProvider } from '@mithic/io/vfs/providers/node-fs';
import { NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';

export function createNodeVfs() {
  const memFs = new MemoryFsProvider();
  memFs.mkdir('/tmp');
  memFs.mkdir('/root');
  const hostFs = new NodeFsProvider({ root: process.cwd() });

  const vfs = new FileSystemRouter();
  return { memFs, hostFs, vfs };
}

export interface MountNodeVfsOptions {
  sockets?: SocketProvider;
}

export async function mountNodeVfs(vfs: FileSystemRouter, memFs: MemoryFsProvider, hostFs: NodeFsProvider, options?: MountNodeVfsOptions) {
  await vfs.mount('/', memFs);
  await vfs.mount('/root', hostFs);
  await vfs.mount('/dev', new DeviceFsProvider({
    stdout: new NodeStdoutHandler(),
    stderr: new NodeStderrHandler(),
  }));
  if (options?.sockets) {
    await vfs.mount('/dev/tcp', new NetworkDeviceFsProvider({ sockets: options.sockets, protocol: 'tcp' }));
    await vfs.mount('/dev/udp', new NetworkDeviceFsProvider({ sockets: options.sockets, protocol: 'udp' }));
  }
}

export function getNodeEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
    PATH: '/usr/bin:/bin',
    HOME: '/root',
  };
}
