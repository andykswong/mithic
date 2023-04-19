<h1 align="center">mithic</h1>

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![docs](https://img.shields.io/badge/docs-typedoc-blue?style=flat-square&logo=typescript&logoColor=white)](http://andykswong.github.io/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

<br/>

> Modular library for real-time isomorphic JavaScript applications

<br />

> **Status: ⚠️ heavily WIP, not for consumption yet.** <br/>
> only in-memory / local storage adapters implemented

## Overview
`mithic` provides the building blocks for creating real-time client-side, server-side and decentralized applications, using [CQRS](https://en.wikipedia.org/wiki/Command%E2%80%93query_separation) architecture with [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) [eventsourcing](https://en.wikipedia.org/wiki/Event_store) for storage.

In `mithic`, events form a causal [Merkle DAG](https://docs.ipfs.tech/concepts/merkle-dag/), instead of just a linear event stream. This enables CRDT stores to be constructed through conflict-free replication of event graph, which is perfect for implementing offline-first and/or decentralized applications.

## Documentation
See generated TypeDoc: https://andykswong.github.io/mithic/

## Getting Started

To use the library, you can depend on the monorepo:
```shell
npm install --save mithic
```
Or select individual [modular packages](#packages) to use:
```shell
npm install --save @mithic/messaging
npm install --save @mithic/cqrs
```

For detailed usages, see the following examples:
- [Simple Redux store example](./packages/examples/simple) - minimal example to get started. Uses the [Redux](https://redux.js.org/) store preset.
- [GraphQL example](./packages/examples/graphql) - example integration with [GraphQL](https://graphql.org/) query, mutation and subscription

## Packages

|Package|NPM|Description|
|-------|---|-----------|
|[`@mithic/collections`](./packages/collections)|[![npm](https://img.shields.io/npm/v/@mithic/collections?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/collections)|collection library|
|[`@mithic/commons`](./packages/commons)|[![npm](https://img.shields.io/npm/v/@mithic/commons?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/commons)|common utility components|
|[`@mithic/cqrs`](./packages/cqrs)|[![npm](https://img.shields.io/npm/v/@mithic/cqrs?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/cqrs)|CQRS library|
|[`@mithic/es`](./packages/es) (WIP)|[![npm](https://img.shields.io/npm/v/@mithic/es?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/es)|Eventsourced data store library|
|[`@mithic/messaging`](./packages/messaging)|[![npm](https://img.shields.io/npm/v/@mithic/messaging?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/messaging)|messaging interface|

## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
