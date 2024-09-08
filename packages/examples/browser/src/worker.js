import { Config, setupEnv, imports, Io, Logger, Level, RemoteIoProvider } from '@mithic/core';

// configure the core APIs
setupEnv();
const { data } = await new Promise(resolve => globalThis.addEventListener?.('message', resolve, { once: true }));
Io.provider = new RemoteIoProvider(data);
Logger.level = Level.Info;
Config.runtime.set('test', 'This is a testing');

// load and run the WASM component
const { instantiate, modules } = await import('@mithic/example-rust-cli/component');
const { run } = await instantiate(
  async (path) => modules[path] && WebAssembly.compile(await (await (await fetch(modules[path])).blob()).arrayBuffer()),
  imports
);

run.run();
