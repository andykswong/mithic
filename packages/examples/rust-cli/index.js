import { isMainThread, workerData, Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { Config, imports, Io, IoReactor, Logger, Level, RemoteIoProvider } from '@mithic/core';

const entryPoint = new URL(process.argv[2] ?? './dist/component.js', import.meta.url).toString();

if (isMainThread) {
  const reactor = new IoReactor();
  new Worker(new URL(import.meta.url), {
    workerData: reactor.addChannel(),
  });
} else {
  Io.provider = new RemoteIoProvider(workerData);
  Logger.level = Level.Info;
  Config.runtime.set('test', 'This is a testing');

  const { instantiate } = await import(entryPoint);
  const { run } = await instantiate(
    async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
    imports
  );

  run.run();
}
