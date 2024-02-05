# @mithic/jsonr

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/jsonr?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/jsonr)
[![docs](https://img.shields.io/badge/docs-typedoc-blue?style=flat-square&logo=typescript&logoColor=white)](http://andykswong.github.io/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

<br/>

> mithic JSON intermediate representation for sandboxed scripting

<br/>

## Install
```shell
npm install --save @mithic/jsonr
```

## Basic Usage
To run an expression:
1. Use a `Parser` (`JsonAstParser`) to parse JSON string into AST
1. Use an `Evaluator` (currently `Interpreter` only) to evaluate the AST against an `Env` (`DefaultEnv`) to get a result as JS object

#### Simplified JavaScript
```js
import { DefaultEnv, Interpreter, JsonAstParser, Stdlib } from '@mithic/jsonr';

const env = new DefaultEnv(null, Stdlib);
const parser = new JsonAstParser();
const evaluator = new Interpreter();

const ast = parser.parse('["+",3,5]');
const result = evaluator.eval(ast, env); // 8
```

## License
This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
