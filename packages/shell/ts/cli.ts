import { readFile } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { WASIProcess } from '@mithic/process/instantiation';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { MemoryFsProvider } from '@mithic/io/vfs';

const componentUrl = new URL('../dist/wasm/component.js', import.meta.url);

const memFs = new MemoryFsProvider();
memFs.mkdir('/tmp');
const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(memFs, '/'));

const shim = new WASIShim({
  sandbox: {
    preopens: { '/': rootDescriptor },
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
    args: ['sh', ...process.argv.slice(2)],
    cwd: '/',
    stdin: { handler: new NodeStdinHandler(), isatty: isatty(0) },
    stdout: { handler: new NodeStdoutHandler(), isatty: isatty(1) },
    stderr: { handler: new NodeStderrHandler(), isatty: isatty(2) },
  },
});

const proc = new WASIProcess();

const importObject = {
  ...shim.getImportObject(),
  ...proc.getImportObject(),
};

const { instantiate } = await import(componentUrl.toString());
const { run } = await instantiate(
  async (path: string) => WebAssembly.compile(await readFile(new URL(path, componentUrl))),
  importObject,
);

try {
  process.exit(run.run());
} catch (e) {
  if (e instanceof ComponentExit) {
    process.exit(e.code);
  }
  throw e;
} finally {
  shim[Symbol.dispose]();
}
