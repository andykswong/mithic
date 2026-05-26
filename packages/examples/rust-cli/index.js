import { readFile } from 'node:fs/promises';
import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';

const entryPoint = new URL(process.argv[2] ?? './dist/component.js', import.meta.url).toString();

const shim = new WASIShim({
  sandbox: {
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
    args: process.argv.slice(1),
    stdin: { handler: new NodeStdinHandler(), isatty: isatty(0) },
    stdout: { handler: new NodeStdoutHandler(), isatty: isatty(1) },
    stderr: { handler: new NodeStderrHandler(), isatty: isatty(2) },
  }
});

const { instantiate } = await import(entryPoint);
const { run } = await instantiate(
  async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
  shim.getImportObject()
);

run.run();
