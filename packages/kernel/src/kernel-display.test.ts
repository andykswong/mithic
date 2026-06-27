import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import type { RelayContext, RelayLauncher } from './kernel.ts';
import type { ProcessHandle, Runtime } from '@mithic/runtime';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { QuickJSRuntime } from '@mithic/runtime/backends/quickjs';
import type { QuickJSSpawnOptions } from '@mithic/runtime/backends/quickjs';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

// Guest echoes its boot DisplayInfo (`init.display`) on stdout as JSON, using the
// real createGuest bootstrap (asserts actual runtime behavior, not types). A
// missing display is reported as the literal null so the test can distinguish
// "absent" from any populated object.
const REPORT_DISPLAY = `
  import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const out = JSON.stringify(boot.init.display ?? null);
    const w = g.stdout.getWriter();
    await w.write(new TextEncoder().encode(out));
    await w.close();
    g.exit(0);
  };`;

async function bootKernel(): Promise<Kernel> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return new Kernel({ runtime: new WorkerRuntime(), vfs });
}

// --- Worker (transfer) path -------------------------------------------------

test('kernel display: window mode → available:true with geometry (container stripped)', async () => {
  const kernel = await bootKernel();
  const container = { nodeType: 1 } as unknown as HTMLElement; // host-only; must NOT cross the wire
  const { pid, stdout } = await kernel.spawn(REPORT_DISPLAY, {
    captureStdout: true,
    display: { mode: 'window', width: 800, height: 600, title: 'X', container },
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toEqual({ available: true, mode: 'window', width: 800, height: 600, title: 'X' });
  expect('container' in d).toBe(false);
}, 15000);

test('kernel display: inline mode → available:true preserves mode + geometry', async () => {
  const kernel = await bootKernel();
  const { pid, stdout } = await kernel.spawn(REPORT_DISPLAY, {
    captureStdout: true,
    display: { mode: 'inline', width: 320, height: 240 },
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toEqual({ available: true, mode: 'inline', width: 320, height: 240 });
}, 15000);

test('kernel display: hidden mode → available:false (no geometry leaks)', async () => {
  const kernel = await bootKernel();
  const { pid, stdout } = await kernel.spawn(REPORT_DISPLAY, {
    captureStdout: true,
    display: { mode: 'hidden', width: 800, height: 600 },
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toEqual({ available: false });
}, 15000);

test('kernel display: no display option → ProcessInit.display absent (null over the wire)', async () => {
  const kernel = await bootKernel();
  const { pid, stdout } = await kernel.spawn(REPORT_DISPLAY, { captureStdout: true });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toBeNull();
}, 15000);

// --- QuickJS (relay) path ---------------------------------------------------
//
// Non-transferable backend: the kernel takes #spawnRelay, which assembles its
// ProcessInit through the SAME #buildProcessInit helper. This proves display is
// threaded on BOTH spawn paths (not just the transfer path). The QuickJS guest
// reads its boot init via the injected `__mithic_init` global.

class QuickJSGuestLauncher implements RelayLauncher {
  #rt: QuickJSRuntime;
  constructor(rt: QuickJSRuntime) {
    this.#rt = rt;
  }
  async launchRelay(runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    void runtime;
    const onSyscall: QuickJSSpawnOptions['onSyscall'] = async (call, args) => {
      switch (call) {
        case 'pipe/write': {
          const fd = Number(args['fd'] ?? 1);
          const rawData = args['data'];
          let chunk: Uint8Array;
          if (rawData instanceof Uint8Array) chunk = rawData;
          else if (Array.isArray(rawData)) chunk = new Uint8Array(rawData as number[]);
          else if (typeof rawData === 'string') chunk = new TextEncoder().encode(rawData);
          else chunk = new Uint8Array(0);
          if (fd === 1) ctx.writeStdout(chunk);
          else if (fd === 2) ctx.writeStderr(chunk);
          return { written: chunk.byteLength };
        }
        case 'process/exit': {
          const code = Number(args['code'] ?? 0);
          ctx.closeStdout();
          ctx.closeStderr();
          ctx.notifyExit(code);
          return {};
        }
        case 'process/getpid':
          return { pid: ctx.init.pid };
        default: {
          const res = await ctx.onSyscall(call, args);
          if (res.ok) return res.result as Record<string, unknown>;
          throw new Error(`${res.error.code}: ${res.error.message}`);
        }
      }
    };
    const handle = await this.#rt.spawn(ctx.code, { init: ctx.init, onSyscall });
    this.#rt
      .waitExit(handle)
      .then(({ code }) => {
        ctx.closeStdout();
        ctx.closeStderr();
        ctx.notifyExit(code);
      })
      .catch(() => ctx.notifyExit(1));
    return handle;
  }
}

async function bootRelayKernel(): Promise<Kernel> {
  const qjsRt = await QuickJSRuntime.create();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  return new Kernel({ runtime: qjsRt, vfs, relayLauncher: new QuickJSGuestLauncher(qjsRt) });
}

const RELAY_REPORT_DISPLAY = `
  __mithic_syscall('pipe/write', { fd: 1, data: JSON.stringify(__mithic_init.display ?? null) });
  __mithic_syscall('process/exit', { code: 0 });
`;

test('kernel display (RELAY): window mode threads display on the relay path too', async () => {
  const kernel = await bootRelayKernel();
  const container = { nodeType: 1 } as unknown as HTMLElement;
  const { pid, stdout } = await kernel.spawn(RELAY_REPORT_DISPLAY, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
    display: { mode: 'window', width: 800, height: 600, title: 'X', container },
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toEqual({ available: true, mode: 'window', width: 800, height: 600, title: 'X' });
  expect('container' in d).toBe(false);
}, 20000);

test('kernel display (RELAY): hidden mode → available:false on the relay path', async () => {
  const kernel = await bootRelayKernel();
  const { pid, stdout } = await kernel.spawn(RELAY_REPORT_DISPLAY, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
    display: { mode: 'hidden' },
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toEqual({ available: false });
}, 20000);

test('kernel display (RELAY): no display option → display absent on the relay path', async () => {
  const kernel = await bootRelayKernel();
  const { pid, stdout } = await kernel.spawn(RELAY_REPORT_DISPLAY, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });
  await kernel.wait(pid);
  const d = JSON.parse(new TextDecoder().decode(await stdout!));
  expect(d).toBeNull();
}, 20000);
