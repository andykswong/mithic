/**
 * mithic:process import map.
 * Maps WIT interface names to their implementations.
 */
import * as types from './types.ts';
import * as manager from './manager.ts';

export const imports = {
  'mithic:process/types': types,
  'mithic:process/manager': manager,
} as const;
