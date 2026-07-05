import { test, expect } from 'vitest';
import type { SpawnOptions } from '../runtime.ts';

test('SpawnOptions carries an optional guestImports map', () => {
  const opts: SpawnOptions = {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
    guestImports: { '@mithic/guest-runtime': 'export const createGuest = () => ({});' },
  };
  expect(opts.guestImports?.['@mithic/guest-runtime']).toContain('createGuest');
});
