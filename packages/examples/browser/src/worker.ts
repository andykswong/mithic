import type { SharedChannelBuffers } from '@mithic/commons';
import { Cli, Config, setupEnvironment, imports, Logger, Level, SyncStdioProvider, StdLogger } from '@mithic/core';

// configure the core APIs
setupEnvironment();
const { data } = await new Promise<MessageEvent<SharedChannelBuffers>>(
  resolve => globalThis.addEventListener?.('message', resolve, { once: true })
);
Cli.stdio = new SyncStdioProvider(data);
Logger.instance = new StdLogger(await Cli.stdio.getStdout(), await Cli.stdio.getStderr());
Logger.level = Level.Info;
Config.runtime.set('test', 'This is a testing');

// load and run the WASM component
const { instantiate, modules } = await import('@mithic/example-rust-cli/component');
const { run } = await instantiate(
  async (path: keyof typeof modules) => modules[path] && WebAssembly.compile(await (await (await fetch(modules[path])).blob()).arrayBuffer()),
  imports
);

run.run();
