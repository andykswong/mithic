import { readFile } from 'node:fs/promises';
import { readSync } from 'node:fs';
import { WASIShim } from '@mithic/wasip2';

const entryPoint = new URL(process.argv[2] ?? './dist/component.js', import.meta.url).toString();

const stdinHandler = {
  read(len) {
    const buf = Buffer.alloc(len);
    try {
      const bytesRead = readSync(0, buf, 0, len, null);
      if (bytesRead === 0) return undefined;
      return new Uint8Array(buf.buffer, 0, bytesRead);
    } catch {
      return undefined;
    }
  },
  blockingRead(len) {
    const buf = Buffer.alloc(len);
    try {
      const bytesRead = readSync(0, buf, 0, len, null);
      if (bytesRead === 0) throw { tag: 'closed' };
      return new Uint8Array(buf.buffer, 0, bytesRead);
    } catch (e) {
      if (e && typeof e === 'object' && 'tag' in e) throw e;
      throw { tag: 'closed' };
    }
  },
};

const shim = new WASIShim({
  sandbox: {
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
    args: process.argv.slice(1),
    stdin: stdinHandler,
    stdout: {
      checkWrite() { return 65536; },
      write(buf) { process.stdout.write(buf); },
      flush() {},
    },
    stderr: {
      checkWrite() { return 65536; },
      write(buf) { process.stderr.write(buf); },
      flush() {},
    },
  }
});

const { instantiate } = await import(entryPoint);
const { run } = await instantiate(
  async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
  shim.getImportObject()
);

run.run();
