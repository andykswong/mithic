import { AtomicPollables, type Pollables } from '@mithic/commons';

let pollables: Pollables;

/** The I/O module. */
export const Io = {
  /** The Pollable states. */
  get pollables(): Pollables {
    if (!pollables) {
      pollables = new AtomicPollables();
    }
    return pollables;
  },
  set pollables(value: Pollables) {
    pollables = value;
  }
};
