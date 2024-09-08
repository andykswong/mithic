import * as atomics from './atomic.ts';
import * as batch from './batch.ts';
import * as query from './query.ts';
import * as store from './store.ts';

/** All runtime imports. */
export const imports = {
  'mithic:keyvalue/atomics': atomics,
  'mithic:keyvalue/batch': batch,
  'mithic:keyvalue/query': query,
  'mithic:keyvalue/store': store,
} as const;
