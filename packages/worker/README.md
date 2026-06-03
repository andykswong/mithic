# @mithic/worker

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/worker?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/worker)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> Web Worker polyfill for Node.js — use `new Worker(url)` idiomatically across platforms

## Overview

`@mithic/worker` provides a Node.js polyfill for the Web Worker API. After importing, you can use `new Worker(url)` with `self.onmessage`, `self.postMessage`, and `self.close()` the same way you would in a browser. On browser environments, the native `Worker` is already available and the polyfill is a no-op.

## Install

```shell
npm install @mithic/worker
```

## Usage

```typescript
// Main thread: import once to register the polyfill
import '@mithic/worker';

// Now use the standard Web Worker API
const worker = new Worker('./my-worker.ts', { type: 'module' });
worker.onmessage = (e) => console.log('from worker:', e.data);
worker.postMessage('hello');
```

```typescript
// Worker file (my-worker.ts): use standard Web Worker globals
onmessage = (e) => {
  postMessage(`echo: ${e.data}`);
};
```

## How It Works

The polyfill module (`src/polyfill.ts`) is a dual-purpose file:

1. **Main-thread side** — If `globalThis.Worker` is undefined (Node.js), it registers a `Worker` class on `globalThis` that wraps `node:worker_threads`. Each `new Worker(url)` spawns a Node.js worker thread that loads the polyfill first (to set up worker globals), then dynamically imports the target module.

2. **Worker-thread side** — When loaded inside a worker thread, it bootstraps `onmessage`, `postMessage`, `close()`, and `self` on `globalThis`, bridging `node:worker_threads` `parentPort` messages to standard `MessageEvent` objects.

In browser environments, `globalThis.Worker` is already defined, so the polyfill skips registration entirely.

## API

The polyfill implements the subset of the Web Worker API used by mithic:

**Main thread (Worker constructor):**
- `new Worker(url, options?)` — Spawn a worker. `url` can be a file path, `file://` URL, or `URL` object.
- `worker.postMessage(data, transfer?)` — Send a message to the worker.
- `worker.terminate()` — Terminate the worker.
- `worker.onmessage` / `worker.onerror` — Event handlers.
- `worker.addEventListener(type, handler)` / `worker.dispatchEvent(event)` — EventTarget interface.

**Worker thread (globals):**
- `onmessage` — Assign a handler to receive messages from the main thread.
- `postMessage(data, transfer?)` — Send a message to the main thread.
- `close()` — Terminate the worker from within.
- `self` — Reference to `globalThis`.
