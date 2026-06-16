import { expect, test } from 'vitest';
import { falseCommand } from './false.ts';
import type { CommandIO } from '../harness.ts';

test('false always exits 1', async () => {
  const io = {
    args: ['false'], env: {}, cwd: '/',
    stdin: new ReadableStream({ start(c) { c.close(); } }),
    stdout: new WritableStream({ write() {} }),
    stderr: new WritableStream({ write() {} }),
    syscall: async () => ({}),
  } as CommandIO;
  expect(await falseCommand(io)).toBe(1);
});
