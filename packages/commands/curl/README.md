# @mithic/curl

A pure-TypeScript curl-like HTTP client that runs as a regular sandboxed Mithic
process. It is a from-scratch reimplementation of a practical subset of curl —
no native binary and no WebAssembly. The guest never holds a socket or `fetch`:
every request goes through the kernel's single `net/fetch` syscall, which is
capability-gated by origin against the process's `net` capability. An origin the
process was not granted is rejected with `EACCES` *before* any request is made —
the sandbox boundary is the kernel.

This package replaces the previous WASM-based curl command.

## Pieces

- `curl.ts` — the guest entry module (built to `dist/curl.js`): the
  `curlCommand` logic that parses argv, builds the request, performs `net/fetch`
  (following redirects), and writes the response. Exported as `curlCommand` for
  direct unit testing without a kernel.
- `harness.ts` — the local command-authoring harness (`defineCommand`,
  `parseArgs`, `readAll`, `writeBytes`/`writeString`/`writeLine`, and the
  `CommandFn` / `CommandIO` types). A getopt-style parser supporting short/long
  flags, clustering, `-o val` / `-oval` / `--out=val` / `--out val`, the `--`
  terminator, aliases, and repeatable "collect" flags such as `-H`.
- `resolver.ts` — `createCurlResolver`, a `resolveCommand(name, cwd, env)`
  factory that maps the name `"curl"` to the built guest module URL for
  `new Kernel({ resolveCommand })`.

## Quick start

```ts
import { Kernel } from '@mithic/kernel';
import { createCurlResolver } from '@mithic/curl';
import { FetchHttpClient } from '@mithic/io/net';

const kernel = new Kernel({
  runtime, vfs,
  resolveCommand: createCurlResolver(),  // compose with other resolvers as needed
  httpClient: new FetchHttpClient(),     // optional — this is the kernel default
});

// A guest spawned with `{ type: 'net', origins: ['https://api.example.com'] }`
// can `curl https://api.example.com/…`; any other origin is EACCES.
```

The kernel performs the actual transfer through its configured `HttpClient`
(`FetchHttpClient` by default). curl issues only `net/fetch` and, for `-o`/`-O`,
the `fs/*` syscalls to write the response file.

## Supported flags

`curl [FLAGS] URL...` — multiple URLs are fetched in sequence; the default
method is `GET` and the response body goes to stdout.

| Flag | Meaning |
|---|---|
| `-X` / `--request METHOD` | set the HTTP method |
| `-H` / `--header 'Name: value'` | add a request header (repeatable) |
| `-d` / `--data DATA` | request body (repeatable, joined with `&`); implies `POST`. `@-` reads the body from stdin |
| `--data-raw DATA` | like `-d` (alias) |
| `--json JSON` | send JSON body and set `Content-Type`/`Accept: application/json`; implies `POST` |
| `-G` | send `-d` data as the URL query string instead of a body |
| `-o` / `--output FILE` | write the body to a VFS file |
| `-O` | write the body to a file named after the URL's last path segment |
| `-i` | include response headers before the body |
| `-I` / `--head` | issue a `HEAD` request and print only headers |
| `-L` | follow `3xx` redirects (up to 50; redirect becomes a `GET` with no body) |
| `-f` / `--fail` | treat HTTP `>= 400` as failure (no body, exit 22) |
| `-w` / `--write-out FORMAT` | print a format string after the transfer |
| `-u` / `--user user:pass` | HTTP Basic auth |
| `-A` / `--user-agent UA` | set `User-Agent` |
| `-e` / `--referer URL` | set `Referer` |
| `--max-time SECONDS` | request timeout |
| `-s` / `--silent` | suppress error messages (`-sS` re-enables them) |
| `-S` / `--show-error` | show errors even when silent |
| `-k` / `--insecure` | accepted but a no-op under `net/fetch` |

`-w` supports `%{http_code}`, `%{size_download}`, `%{url_effective}`,
`%{content_type}`, and `%%`; `\n`/`\t`/`\r` escapes are expanded.

## Exit codes

A subset of curl's table, mapped from the kernel errno on a `net/fetch`
rejection:

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage error (no URL) |
| `3` | malformed URL |
| `6` | couldn't resolve host (`ENOTFOUND`) |
| `7` | couldn't connect (`EHOSTUNREACH`/`ECONNREFUSED`/`ENETUNREACH`/`ETIMEDOUT`, and capability denials) |
| `22` | HTTP error response with `-f` |

## Testing

```sh
npm run build && npm test    # build first — tests import from dist/
```
