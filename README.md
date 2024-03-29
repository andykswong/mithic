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
`mithic` provides the building blocks for creating offline-first applications, using [CQRS](https://en.wikipedia.org/wiki/Command%E2%80%93query_separation) architecture with [eventsourced](https://en.wikipedia.org/wiki/Event_store) [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)s for storage and data replication. `mithic` is network agnostic and can be used in traditional client-server, decentralized, or local-only apps. Target use cases include business web apps, collaborative editing, multiplayer gaming, etc.

## Documentation
See generated TypeDoc: https://andykswong.github.io/mithic/

## Getting Started

To use the library, you can depend on the monorepo:
```shell
npm install --save mithic
```
Or select individual [modular packages](#packages) to use:
```shell
npm install --save @mithic/collections @mithic/cqrs @mithic/crdt
```

For detailed usages, see the following examples:
- [Simple Redux store example](./packages/examples/simple) - minimal example to get started. Uses the [Redux](https://redux.js.org/) store preset.
- [GraphQL example](./packages/examples/graphql) - example integration with [GraphQL](https://graphql.org/) query, mutation and subscription

## Packages

Core:

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/collections`](./packages/collections)|[![npm](https://img.shields.io/npm/v/@mithic/collections?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/collections)|Core collection interfaces and implementations|
|[`@mithic/commons`](./packages/commons)|[![npm](https://img.shields.io/npm/v/@mithic/commons?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/commons)|Common utilities|
|[`@mithic/cqrs`](./packages/cqrs)|[![npm](https://img.shields.io/npm/v/@mithic/cqrs?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/cqrs)|CQRS interface|
|[`@mithic/crdt`](./packages/crdt)|[![npm](https://img.shields.io/npm/v/@mithic/crdt?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/crdt)|Eventsourced CRDT library|
|[`@mithic/jsonr`](./packages/jsonr)|[![npm](https://img.shields.io/npm/v/@mithic/jsonr?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/jsonr)|JSON intermediate representation for sandboxed scripting|
|[`@mithic/messaging`](./packages/messaging)|[![npm](https://img.shields.io/npm/v/@mithic/messaging?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/messaging)|Messaging interface|

Plugins:

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/denokv`](./packages/plugins/denokv)|[![npm](https://img.shields.io/npm/v/@mithic/denokv?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/denokv)|Deno KV adapters|
|[`@mithic/ipfs`](./packages/plugins/ipfs)|[![npm](https://img.shields.io/npm/v/@mithic/ipfs?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/ipfs)|IPFS and libp2p adapters|
|[`@mithic/level`](./packages/plugins/level)|[![npm](https://img.shields.io/npm/v/@mithic/level?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/level)|abstract-level adapters|
|[`@mithic/redis`](./packages/plugins/redis)|[![npm](https://img.shields.io/npm/v/@mithic/redis?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/redis)|Redis adapters|


## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
