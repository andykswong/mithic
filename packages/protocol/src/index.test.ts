import { expect, test } from 'vitest';
import * as protocol from './index.ts';

test('barrel re-exports the public surface', () => {
  expect(protocol.ERRNO_CODES).toBeDefined();
  expect(protocol.SIGNALS).toBeDefined();
  expect(protocol.makeSyscallRequest).toBeTypeOf('function');
  expect(protocol.DEFAULT_FD_ACTIONS).toBeDefined();
  expect(protocol.TRANSFER_THRESHOLD_BYTES).toBe(10240);
});
