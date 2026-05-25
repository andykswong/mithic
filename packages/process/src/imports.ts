/**
 * mithic:process import map.
 * Maps WIT interface names to their implementations.
 */
import * as manager from './manager.ts';

export const imports = {
  'mithic:process/manager': manager,
} as const;
