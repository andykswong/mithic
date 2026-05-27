import { readFile } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { WASIProcess } from '@mithic/process/instantiation';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';

const componentUrl = new URL('../dist/wasm/component.js', import.meta.url);

const shim = new WASIShim({
  sandbox: {
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)),
    args: ['msh'],
    cwd: process.cwd(),
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
