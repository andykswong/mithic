/**
 * WASIProcess — configures process spawning for a WASM component.
 * Analogous to WASIShim for WASI interfaces.
 *
 * Usage:
 *   const proc = new WASIProcess({ commandResolver: myResolver });
 *   const imports = proc.getImportObject();
 */

import type { Process, SpawnOptions } from './types.ts';
import { spawnProcess, type CommandResolver } from './spawn.ts';
import { ProcessTable } from './table.ts';

export interface WASIProcessConfig {
  /** Command resolver — maps file paths to handlers. */
  commandResolver?: CommandResolver;
  /** Process table to use (default: creates new one). */
  processTable?: ProcessTable;
}

export class WASIProcess {
  #table: ProcessTable;
  #resolver: CommandResolver;

  constructor(config?: WASIProcessConfig) {
    this.#table = config?.processTable ?? new ProcessTable();
    this.#resolver = config?.commandResolver ?? (() => undefined);
  }

  /** Get the mithic:process import object for component instantiation. */
  getImportObject(): { 'mithic:process/spawn': { spawn: (file: string, args: string[], options?: SpawnOptions) => Process } } {
    const table = this.#table;
    const resolver = this.#resolver;
    return {
      'mithic:process/spawn': {
        spawn: (file: string, args: string[], options?: SpawnOptions) =>
          spawnProcess(table, resolver, file, args, options),
      },
    };
  }

  /** Get the process table for this instance. */
  get table(): ProcessTable { return this.#table; }
}
