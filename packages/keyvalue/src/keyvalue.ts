import type { KeyValueProvider } from './service.ts';
import * as atomics from './atomic.ts';
import * as batch from './batch.ts';
import * as query from './query.ts';
import * as store from './store.ts';
import { InMemoryKeyValueProvider } from './impl/index.ts';

let provider: KeyValueProvider;

/** Keyvalue store module. */
export const KeyValue = {
  /** The underlying keyvalue store provider. */
  get provider(): KeyValueProvider {
    if (!provider) {
      provider = new InMemoryKeyValueProvider();
    }
    return provider;
  },
  set provider(value: KeyValueProvider) {
    provider = value;
  },

  /** Keyvalue store module imports. */
  imports: {
    'mithic:keyvalue/atomics': atomics,
    'mithic:keyvalue/batch': batch,
    'mithic:keyvalue/query': query,
    'mithic:keyvalue/store': store,
  },
};
