# Shell Example

> **Pending re-adaptation to xterm.js + @mithic/shell (JS) — see v2 plan.**

This example is parked during the Mithic 2.0 migration. The original WASM-based sources
are preserved in `legacy-wasm/` for reference and will be rewritten in a later phase.

## Planned Re-adaptation

- Replace the Rust WASM shell with `@mithic/shell` running as an Mithic process
- Replace WASM coreutils with the Mithic kernel + process model
- Keep xterm.js as the terminal frontend
- No SharedArrayBuffer / WASI P2 dependencies
