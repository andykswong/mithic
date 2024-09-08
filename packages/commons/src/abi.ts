export const symbolCabiLower = Symbol.for('cabiLower');

/**
 * Canonical options for optimizaed host binding.
 * See: https://github.com/bytecodealliance/jco/blob/main/docs/src/optimized-host-bindings.md
 */
export interface CanonOpts {
  /** WASM memory. */
  memory: WebAssembly.Memory;

  /** C-like realloc function. */
  realloc: (origPtr: number, origSize: number, alignment: number, newSize: number) => number;

  /** List of resource tables. */
  resourceTables: number[][],
}

/** Host function with an optional optimized binding. */
export interface HostFunction<Ret = unknown, Args extends unknown[] = unknown[]> {
  (...args: Args): Ret;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [symbolCabiLower]?: (opts: CanonOpts) => (...args: any[]) => number | boolean | void;
}

/** Result variant type. */
export type Result<T = undefined, E = undefined> = {
  tag: 'ok',
  val: T,
} | {
  tag: 'err',
  val: E,
};
