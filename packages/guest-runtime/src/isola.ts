import type { ProcessInit } from '@mithic/protocol';
import { portToReadable, portToWritable } from './streams.ts';
import { FdTable, makeDefaultEntry } from './fd-table.ts';
import { SyscallClient } from './syscall-client.ts';
import { MessagePortTransport } from './transport.ts';

export interface IsolaRuntime {
  pid: number;
  ppid: number;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  syscall(call: string, args: Record<string, unknown>): Promise<unknown>;
  fdTable: FdTable;
}

export async function initIsola(port: MessagePort): Promise<IsolaRuntime> {
  // Wait for ProcessInit message
  const init = await new Promise<ProcessInit>((resolve) => {
    port.onmessage = (e: MessageEvent) => {
      const msg = e.data as unknown;
      if (typeof msg === 'object' && msg !== null && 'type' in msg && (msg as { type: unknown }).type === 'init') {
        resolve(msg as ProcessInit);
      }
    };
    port.start?.();
  });

  // Create syscall transport (same port, reset handler)
  const transport = new MessagePortTransport(port);
  const client = new SyscallClient(transport);

  const fdTable = new FdTable();

  // Set up stdio from preopens
  const preopens = init.preopens ?? {};

  // Default stdio streams - will be replaced if preopens provide ports
  let stdin: ReadableStream<Uint8Array> = new ReadableStream({ start(c) { c.close(); } });
  let stdout: WritableStream<Uint8Array> = new WritableStream();
  let stderr: WritableStream<Uint8Array> = new WritableStream();

  // Process preopens
  for (const [fdStr, desc] of Object.entries(preopens)) {
    const fd = Number(fdStr);
    if (desc.type === 'pipe') {
      fdTable.set(fd, makeDefaultEntry({
        rights: {
          read: desc.rights?.read ?? true,
          write: desc.rights?.write ?? true,
          seek: false,
          stat: false,
          truncate: false,
        },
        flags: { append: false, nonblock: false },
      }));
    }
  }

  // Notify ready
  port.postMessage({ type: 'ready' });

  return {
    pid: init.pid,
    ppid: init.ppid,
    args: init.args,
    env: init.env,
    cwd: init.cwd,
    stdin,
    stdout,
    stderr,
    syscall: (call, args) => client.syscall(call, args),
    fdTable,
  };
}
