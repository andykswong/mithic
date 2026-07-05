/// <reference types="vite/client" />

/** `?bundle` (see `build/bundle-plugin.ts`) yields a module's self-contained IIFE source text. */
declare module '*?bundle' {
  const source: string;
  export default source;
}

/** `?bundle-esm` (see `build/bundle-plugin.ts`) yields a module's self-contained ESM source text (named exports preserved). */
declare module '*?bundle-esm' {
  const source: string;
  export default source;
}
