import { isMainThread, workerData, Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { imports, Cli, IoStreamReactor, SyncStdioProvider } from '@mithic/core';

let reactor, worker;

if (isMainThread) {
  // create an I/O reactor on main thread to process
  reactor = new IoStreamReactor();
  // run component on a worker, passing the reactor channel as worker data
  worker = new Worker(new URL(import.meta.url), {
    workerData: reactor.addChannel(),
  });
} else {
  await workerThread();
}

async function workerThread(entry = process.argv[2] ?? './dist/component.js') {
  // init stdio provider that connects to the reactor on main thread
  Cli.stdio = new SyncStdioProvider(workerData);

  // load the WASM component and run it
  const entryPoint = new URL(entry, import.meta.url).toString();
  const { instantiate } = await import(entryPoint);
  const { run } = await instantiate(
    async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
    imports
  );

  run.run();
}

export { reactor, worker };
