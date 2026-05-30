# Shell Example

Interactive xterm.js shell running the Mithic WASM shell in the browser.

## Prerequisites

- Node.js >= 22.8.0
- npm

## Running

```shell
npm install
npm run dev
```

This starts a Vite dev server. Open the displayed URL in your browser.

## Browser Requirements

### Cross-Origin Isolation Headers

The shell uses `SharedArrayBuffer` for synchronous I/O between the WASM worker and the main thread. Browsers require the following HTTP headers for `SharedArrayBuffer` to be available:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite dev server is pre-configured to serve these headers. If deploying to production, ensure your server/CDN sets them as well.

### Web Worker Architecture

`Atomics.wait()` cannot be called on the browser main thread. The shell example uses the following architecture:

- **Main thread**: Renders xterm.js terminal UI, runs the `IoLoop` that services VFS/network requests asynchronously
- **Worker thread**: Executes the WASM shell component with `SyncBridge*` providers that block via `Atomics.wait()` until the main thread completes the requested I/O operation

### Browser Compatibility

Requires a modern browser with support for:

- `SharedArrayBuffer`
- `Atomics`
- Web Workers (module type)
- WebAssembly (with Component Model via jco/ComponentizeJS)
