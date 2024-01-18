<h1 align="center">mithic</h1>

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![docs](https://img.shields.io/badge/docs-typedoc-blue?style=flat-square&logo=typescript&logoColor=white)](http://andykswong.github.io/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

<br/>

> Modular library for offline-first isomorphic JavaScript applications

<br />

## Overview
`mithic` provides the building blocks for creating offline-first client-server or decentralized applications, using [CQRS](https://en.wikipedia.org/wiki/Command%E2%80%93query_separation) architecture with [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) [eventsourcing](https://en.wikipedia.org/wiki/Event_store) for storage and data replication. Targeted use cases include business web apps, collaborative editing, multiplayer gaming, etc.

## Documentation
See generated TypeDoc: https://andykswong.github.io/mithic/

## Getting Started

To use the library, you can depend on the monorepo:
```shell
npm install --save mithic
```
Or select individual [modular packages](#packages) to use:
```shell
npm install --save @mithic/cqrs @mithic/crdt @mithic/eventstore
```

For detailed usages, see the following examples:
- [Simple Redux store example](./packages/examples/simple) - minimal example to get started. Uses the [Redux](https://redux.js.org/) store preset.
- [GraphQL example](./packages/examples/graphql) - example integration with [GraphQL](https://graphql.org/) query, mutation and subscription

## Packages

Core:

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/collections`](./packages/collections)|[![npm](https://img.shields.io/npm/v/@mithic/collections?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/collections)|collection library|
|[`@mithic/commons`](./packages/commons)|[![npm](https://img.shields.io/npm/v/@mithic/commons?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/commons)|common utility components|
|[`@mithic/cqrs`](./packages/cqrs)|[![npm](https://img.shields.io/npm/v/@mithic/cqrs?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/cqrs)|CQRS library|
|[`@mithic/crdt`](./packages/crdt)|[![npm](https://img.shields.io/npm/v/@mithic/crdt?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/crdt)|eventsourced CRDT library|
|[`@mithic/eventstore`](./packages/eventstore)|[![npm](https://img.shields.io/npm/v/@mithic/eventstore?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/eventstore)|eventstore library|
|[`@mithic/messaging`](./packages/messaging)|[![npm](https://img.shields.io/npm/v/@mithic/messaging?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/messaging)|messaging interface|
|[`@mithic/triplestore`](./packages/triplestore)|[![npm](https://img.shields.io/npm/v/@mithic/triplestore?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/triplestore)|triplestore library|

Plugins:

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/denokv`](./packages/plugins/denokv)|[![npm](https://img.shields.io/npm/v/@mithic/denokv?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/denokv)|Deno KV adapters|
|[`@mithic/ipfs`](./packages/plugins/ipfs)|[![npm](https://img.shields.io/npm/v/@mithic/ipfs?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/ipfs)|IPFS and libp2p adapters|
|[`@mithic/level`](./packages/plugins/level)|[![npm](https://img.shields.io/npm/v/@mithic/level?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/level)|abstract-level adapters|
|[`@mithic/redis`](./packages/plugins/redis)|[![npm](https://img.shields.io/npm/v/@mithic/redis?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/redis)|Redis adapters|


## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
