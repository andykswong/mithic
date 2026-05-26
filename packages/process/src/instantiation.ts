/**
 * WASIProcess — provides the mithic:process/manager import object for WASM components.
 * Accepts any ProcessManager implementation.
 *
 * Usage:
 *   const proc = new WASIProcess({ manager: myProcessManager });
 *   const imports = proc.getImportObject();
 */

import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { Process, type SpawnOptions, type ProcessManager, type PipeOptions } from './types.ts';
import { SimpleProcessManager, type SimpleProcessManagerConfig } from './impl/simple.ts';

export interface WASIProcessConfig {
  /** Provide a fully custom ProcessManager. Takes precedence over other options. */
  manager?: ProcessManager;
  /** Config for the built-in SimpleProcessManager (used when manager is not provided). */
  commandResolver?: SimpleProcessManagerConfig['commandResolver'];
  processTable?: SimpleProcessManagerConfig['processTable'];
  hostStreams?: SimpleProcessManagerConfig['hostStreams'];
}

export class WASIProcess {
  readonly #manager: ProcessManager;

  constructor(config?: WASIProcessConfig) {
    if (config?.manager) {
      this.#manager = config.manager;
    } else {
      this.#manager = new SimpleProcessManager({
        commandResolver: config?.commandResolver,
        processTable: config?.processTable,
        hostStreams: config?.hostStreams,
      });
    }
  }

  /** Get the mithic:process import object for component instantiation. */
  getImportObject(): {
    'mithic:process/types': { Process: typeof Process };
    'mithic:process/manager': {
      spawn: (file: string, args: string[], options?: SpawnOptions) => Process;
      createPipe: (options?: PipeOptions) => { input: InputStream; output: OutputStream };
    };
  } {
    return {
      'mithic:process/types': { Process },
      'mithic:process/manager': {
        spawn: (file, args, options) => this.#manager.spawn(file, args, options),
        createPipe: (options) => this.#manager.createPipe(options),
      },
    };
  }

  /** Get the underlying ProcessManager. */
  get manager(): ProcessManager { return this.#manager; }
}
