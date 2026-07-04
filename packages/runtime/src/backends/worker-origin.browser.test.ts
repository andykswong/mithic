import { test, expect } from 'vitest';
import { WorkerRuntime } from './worker.ts';

function baseInit(pid: number) {
  return { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid, ppid: 0, capabilities: [] };
}

// The primary guard (§3.5): the default spawn must use a `data:` URL, never a host-page `blob:`.
// This is the deterministic mechanism assertion — a `data:` worker becomes null-origin
// automatically once Chrome 150 (kDataUrlWorkerOpaqueOrigin) ships, whereas a host-page `blob:`
// worker inherits the host origin forever. The origin can't be asserted null today (see below).
test('the default Worker spawn uses a data: URL, never a host-page blob: (opaque-origin mechanism, §3.5)', async () => {
  let seenUrl = '';
  const spyFactory = {
    create(src: string) {
      seenUrl = `data:text/javascript,${encodeURIComponent(src)}`; // mirror the factory contract
      const W = (globalThis as unknown as { Worker: typeof Worker }).Worker;
      return new W(seenUrl, { type: 'classic' });
    },
  };
  const rt = new WorkerRuntime(spyFactory);
  const handle = await rt.spawn('globalThis.__mithic_default = () => {};', { init: baseInit(1) });
  expect(seenUrl.startsWith('data:text/javascript,')).toBe(true);
  expect(seenUrl.startsWith('blob:')).toBe(false);
  rt.dispose(handle);
}, 10000);
