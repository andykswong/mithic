import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import { parse } from './parser.ts';

function mockKernel() {
  const spawned: any[] = [];
  return {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async pipe() { return { readfd: 100, writefd: 101 }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
}

test('a pipeline spawns one child per stage and wires pipes', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} });
  const code = await ex.run(parse('alpha | beta | gamma'));
  expect(k.spawned).toHaveLength(3);
  expect(code).toBe(0);
});

test('builtin runs in-process without spawning', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} });
  await ex.run(parse('cd /tmp'));
  expect(k.spawned).toHaveLength(0);
  expect(ex.context.cwd).toBe('/tmp');
});
