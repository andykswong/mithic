import type { KeyValueApiProvider } from './adapter.ts';
import { RemoteKeyValueStore } from './client.ts';

let provider: KeyValueApiProvider;

/** Keyvalue store. */
export const KeyValue = {
  /** The keyvalue store API provider. */
  get provider(): KeyValueApiProvider {
    if (!provider) {
      provider = new RemoteKeyValueStore();
    }
    return provider;
  },
  set provider(value: KeyValueApiProvider) {
    provider = value;
  },
};
