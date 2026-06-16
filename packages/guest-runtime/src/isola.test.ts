import { expect, test } from 'vitest';
import { createGuest } from './isola.ts';

test('createGuest exposes env/args/pid and stdio from init', async () => {
  const { port1, port2 } = new MessageChannel();        // control port pair
  const stdoutCh = new MessageChannel();
  const guest = createGuest({
    control: port2,
    init: {
      type: 'init', entry: 'inline', args: ['prog', 'a'], env: { FOO: 'bar' },
      cwd: '/', pid: 9, ppid: 0, capabilities: [],
    },
    preopenPorts: { 1: stdoutCh.port1 },
  });
  expect(guest.pid).toBe(9);
  expect(guest.args).toEqual(['prog', 'a']);
  expect(guest.env.FOO).toBe('bar');
  const w = guest.stdout.getWriter();
  await w.write(new TextEncoder().encode('hi'));
  const got: unknown[] = [];
  stdoutCh.port2.onmessage = (e) => got.push(e.data);
  stdoutCh.port2.start?.();
  await new Promise(r => setTimeout(r, 20));
  expect(got.some(m => (m as { type?: string }).type === 'data')).toBe(true);
  port1.close();
});
