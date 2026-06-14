# @mithic/curl

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/curl?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/curl)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

Standalone curl HTTP client as a WASI Preview 2 component using `wasi:http/outgoing-handler`.

## Supported Flags

| Flag | Description |
|------|-------------|
| `-X`, `--request` | HTTP method (GET, POST, PUT, DELETE, etc.) |
| `-H`, `--header` | Add request header (`Name: Value`) |
| `-d`, `--data` | Request body (implies POST if no -X) |
| `-o`, `--output` | Write response to file instead of stdout |
| `-s`, `--silent` | Suppress error messages |
| `-i`, `--include` | Include response headers in output |
| `-v`, `--verbose` | Show request/response headers on stderr |
| `-L`, `--location` | Follow redirects (max 10) |
| `-f`, `--fail` | Exit non-zero on HTTP 4xx/5xx |
| `-w`, `--write-out` | Format string after response (`%{http_code}`, `%{content_type}`) |
| `--connect-timeout` | Connection timeout in seconds |

Combined short flags are supported (e.g., `-sfL`).

## Architecture

Single `wasm32-wasip2` binary. HTTP requests are made via `wasi:http/outgoing-handler`. The host runtime provides the HTTP implementation — in Node.js this is backed by `FetchHttpClient`; in Worker mode it's bridged via `SyncBridgeHttpClient`.

## Build & Test

```bash
npm run build        # cargo build + wasm-tools strip + jco transpile + vite
npm run typecheck    # tsc --noEmit
npm test             # cargo test + node --test
```

## Usage from Shell

The `curl` command is resolved by the shell's command resolver (both worker and async modes). It supports piping to other commands:

```bash
curl -s http://api.example.com/data | jq '.items[]'
curl -X POST -d '{"key":"value"}' -H 'Content-Type: application/json' http://api.example.com/endpoint
```
