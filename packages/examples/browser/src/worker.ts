import { WASIShim } from '@mithic/wasip2';
import { WorkerIo } from '@mithic/io/io';
import { SyncBridgeInputStreamHandler, SyncBridgeOutputStreamHandler } from '@mithic/io/io/providers/sync-bridge';
import { STDIN, STDOUT, STDERR } from '@mithic/io/io';

// Wait for the MessagePort from the main thread's IoLoop
const port = await new Promise<MessagePort>((resolve) => {
  globalThis.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'port') {
      resolve(e.data.port);
    }
  };
});

const io = new WorkerIo(port);

const shim = new WASIShim({
  sandbox: {
    args: ['mithic-cli'],
    env: { TEST: 'hello from browser' },
    stdin: { handler: new SyncBridgeInputStreamHandler(io, STDIN), isatty: true },
    stdout: { handler: new SyncBridgeOutputStreamHandler(io, STDOUT), isatty: true },
    stderr: { handler: new SyncBridgeOutputStreamHandler(io, STDERR), isatty: true },
  }
});

const { instantiate, modules } = await import('@mithic/example-rust-cli/component');
const { run } = await instantiate(
  async (path: keyof typeof modules) => modules[path] && WebAssembly.compile(await (await (await fetch(modules[path])).blob()).arrayBuffer()),
  shim.getImportObject()
);

run.run();
