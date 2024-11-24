<h1 align="center">mithic</h1>

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![docs](https://img.shields.io/badge/docs-typedoc-blue?style=flat-square&logo=typescript&logoColor=white)](http://andykswong.github.io/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

<br/>

> Modular library for universal full-stack JavaScript and WebAssembly applications 

## Overview
`mithic` provides the building blocks for creating universal full-stack applications using JavaScript and/or WebAssembly. `mithic` is plaform and runtime agnostic, being usable for both frontend (web, desktop, mobile) and backend in traditional client-server or decentralized architecture through a set of standardized API abstractions based on ([WASI](https://wasi.dev/), [keyvalue store](./packages/keyvalue/), [messaging](./packages/messaging/)). Target use cases include business apps, collaborative editing, multiplayer gaming, etc.

`mithic` supports [WebAssembly Component](https://github.com/WebAssembly/component-model). As Wasm components are not yet widely supported, they need to be transpiled, using [jco](https://github.com/bytecodealliance/jco). For detailed usages, see the following [examples](./packages/examples/):
- [Simple](./packages/examples/simple) - JS WebAssembly component built with [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS)
- [Rust cli](./packages/examples/rust-cli) - Rust WebAssembly component
- [Browser](./packages/examples/browser) - running WebAssembly component in browser

## Getting Started

To use the library, you can depend on individual [modular packages](#packages) or the monorepo:
```shell
npm install --save @mithic/core @mithic/keyvalue @mithic/messaging # core API packages
npm install --save mithic # monorepo has dependency to all of above
```

Below is an example script to run a wasm component in Node.js. As components may be blocking, they must be run in a worker.
```js
import { isMainThread, workerData, Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { Config, imports, Io, IoReactor, Logger, Level, RemoteIoProvider } from '@mithic/core';

if (isMainThread) {
  const reactor = new IoReactor(); // required to use stdin/out/err from wasi-cli
  new Worker(new URL(import.meta.url), { workerData: reactor.addChannel() });
} else {
  Io.provider = new RemoteIoProvider(workerData);
  Logger.level = Level.Info; // set log level for wasi-logging

  // instantiate the component built with jco
  const { instantiate } = await import('./component.js');
  const { run } = await instantiate(async (path) => WebAssembly.compile(await readFile(path)), imports);

  run.run();
}
```

## API
See generated TypeDoc: https://andykswong.github.io/mithic/

## Packages

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/commons`](./packages/commons)|[![npm](https://img.shields.io/npm/v/@mithic/commons?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/commons)|Common utilities|
|[`@mithic/core`](./packages/core)|[![npm](https://img.shields.io/npm/v/@mithic/core?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/core)|Core runtime APIs based on WASI|
|[`@mithic/keyvalue`](./packages/keyvalue)|[![npm](https://img.shields.io/npm/v/@mithic/keyvalue?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/keyvalue)|Key-value store API|
|[`@mithic/messaging`](./packages/messaging)|[![npm](https://img.shields.io/npm/v/@mithic/messaging?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/messaging)|Messaging API for pub/sub, message queue, etc.|

Plugins:

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/denokv`](./packages/plugins/denokv)|[![npm](https://img.shields.io/npm/v/@mithic/denokv?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/denokv)|Deno KV adapters for keyvalue and messaging APIs|
|[`@mithic/level`](./packages/plugins/level)|[![npm](https://img.shields.io/npm/v/@mithic/level?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/level)|abstract-level adapter for keyvalue API|
|[`@mithic/redis`](./packages/plugins/redis)|[![npm](https://img.shields.io/npm/v/@mithic/redis?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/redis)|Redis adapter for keyvalue and messaging APIs|

## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
