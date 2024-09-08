import { isMainThread, workerData, Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { imports, Io, IoReactor, RemoteIoProvider } from '@mithic/core';

let worker;

if (isMainThread) {
  // create an I/O reactor on main thread to process 
  const reactor = new IoReactor();
  // run component on a worker, passing the reactor channel as worker data
  worker = new Worker(new URL(import.meta.url), {
    workerData: reactor.addChannel(),
  });
} else {
  await workerThread();
}

async function workerThread(entry = process.argv[2] ?? './dist/component.js') {
  // init I/O provider that connects to the reactor on main thread
  Io.provider = new RemoteIoProvider(workerData);

  // load the WASM component and run it
  const entryPoint = new URL(entry, import.meta.url).toString();
  const { instantiate } = await import(entryPoint);
  const { run } = await instantiate(
    async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
    imports
  );

  run.run();
}

export { worker };
