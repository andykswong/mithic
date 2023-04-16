import { jest } from '@jest/globals';

export function flushPromises() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Promise(resolve => jest.requireActual<any>('timers').setImmediate(resolve));
}
