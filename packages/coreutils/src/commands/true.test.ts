import { expect, test } from 'vitest';
import { trueCommand } from './true.ts';
import type { CommandIO } from '../harness.ts';

test('true always exits 0', async () => {
  const io = {
    args: ['true'], env: {}, cwd: '/',
    stdin: new ReadableStream({ start(c) { c.close(); } }),
    stdout: new WritableStream({ write() {} }),
    stderr: new WritableStream({ write() {} }),
    syscall: async () => ({}),
  } as CommandIO;
  expect(await trueCommand(io)).toBe(0);
});
