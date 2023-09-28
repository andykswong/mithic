# GraphQL CQRS Example

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](../../../LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

This is an example of implementing a [GraphQL](https://graphql.org/) endpoint using the mithic CQRS [Redux](https://redux.js.org/)-like store.

GraphQL is a good match for CQRS. It explicitly separates mutations (commands) from queries, just like the CQRS pattern. Subscribing to event / state change is also possible through GraphQL subscription.

## Usage
```shell
git clone https://github.com/andykswong/mithic.git
npm install
cd ./packages/examples/graphql

npm start  # run directly
npm test   # run as a jest test
```

## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](../../../LICENSE) for more information.
