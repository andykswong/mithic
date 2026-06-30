/// <reference types="vite/client" />

/** `?bundle` (see `build/bundle-plugin.ts`) yields a module's self-contained IIFE source text. */
declare module '*?bundle' {
  const source: string;
  export default source;
}
