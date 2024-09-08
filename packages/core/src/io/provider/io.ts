import { AtomicPollables } from '@mithic/commons';
import { type IoProvider } from './provider.ts';
import { RemoteIoProvider } from './client.ts';

let provider: IoProvider;

/** The I/O module. */
export const Io = {
  /** The Pollable states. */
  pollables: new AtomicPollables(),

  /** The I/O provider. */
  get provider(): IoProvider {
    if (!provider) {
      provider = new RemoteIoProvider();
    }
    return provider;
  },

  set provider(value: IoProvider) {
    provider = value;
  },
};
