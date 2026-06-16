# Shell Example

> **Pending re-adaptation to xterm.js + @mithic/shell-js (JS) — see v2 plan.**

This example is parked during the Isola 2.0 migration. The original WASM-based sources
are preserved in `legacy-wasm/` for reference and will be rewritten in a later phase.

## Planned Re-adaptation

- Replace the Rust WASM shell with `@mithic/shell-js` running as an Isola process
- Replace WASM coreutils with the Isola kernel + process model
- Keep xterm.js as the terminal frontend
- No SharedArrayBuffer / WASI P2 dependencies
