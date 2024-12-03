import { isMainThread, workerData, Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { Cli, Config, imports, IoStreamReactor, Logger, Level, SyncStdioProvider } from '@mithic/core';

const entryPoint = new URL(process.argv[2] ?? './dist/component.js', import.meta.url).toString();

if (isMainThread) {
  const reactor = new IoStreamReactor();
  new Worker(new URL(import.meta.url), {
    workerData: reactor.addChannel(),
  });
} else {
  Cli.stdio = new SyncStdioProvider(workerData);
  Logger.level = Level.Info;
  Config.runtime.set('test', 'This is a testing');

  const { instantiate } = await import(entryPoint);
  const { run } = await instantiate(
    async (path) => WebAssembly.compile(await readFile(new URL(path, entryPoint))),
    imports
  );

  run.run();
}
