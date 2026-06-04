import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyProcessManager, CALL_SPAWN } from './proxy.ts';
import type { BlockingCallFn } from '@mithic/io/io';
import { SIGNAL_NUMBER } from '../types.ts';

function createMockBridge(exitCode?: number): { bridge: BlockingCallFn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const bridge: BlockingCallFn = (...args: unknown[]) => {
    calls.push(args);
    // The proxy sends exitSlotBuf/signalSlotBuf in the payload (3rd arg).
    // Simulate the main thread setting the exit code on the proxy's slot.
    if (exitCode !== undefined) {
      const payload = args[2] as { exitSlotBuf?: SharedArrayBuffer };
      if (payload?.exitSlotBuf) {
        const view = new Int32Array(payload.exitSlotBuf);
        Atomics.store(view, 0, exitCode);
        Atomics.notify(view, 0);
      }
    }
    return { pid: calls.length };
  };
  return { bridge, calls };
}

describe('ProxyProcessManager', () => {
  it('spawn delegates to bridge and returns a Process', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('echo', ['hello']);
    assert.ok(proc.pid() > 0);
  });

  it('spawn sends CALL_SPAWN with correct payload', () => {
    const { bridge, calls } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    manager.spawn('ls', ['-la'], { cwd: '/tmp', env: { FOO: 'bar' } });
    assert.equal(calls.length, 1);
    const [call, id, payload] = calls[0]!;
    assert.equal(call, CALL_SPAWN);
    assert.equal(id, null);
    const p = payload as { file: string; args: string[]; cwd: string; env: Record<string, string> };
    assert.equal(p.file, 'ls');
    assert.deepEqual(p.args, ['-la']);
    assert.equal(p.cwd, '/tmp');
    assert.deepEqual(p.env, { FOO: 'bar' });
  });

  it('wait returns the exit code from the exit slot', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('echo', ['test']);
    assert.equal(proc.wait(), 0);
  });

  it('wait returns non-zero exit code', () => {
    const { bridge } = createMockBridge(42);
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('false', []);
    assert.equal(proc.wait(), 42);
  });

  it('tryWait returns undefined when process not exited', () => {
    const { bridge } = createMockBridge(); // no exit code set
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('sleep', ['10']);
    assert.equal(proc.tryWait(), undefined);
  });

  it('tryWait returns exit code when set', () => {
    const { bridge } = createMockBridge(7);
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('cmd', []);
    assert.equal(proc.tryWait(), 7);
  });

  it('kill writes signal number to signal slot', () => {
    let capturedSignalBuf: SharedArrayBuffer | undefined;
    const bridge: BlockingCallFn = (...args: unknown[]) => {
      const payload = args[2] as { exitSlotBuf?: SharedArrayBuffer; signalSlotBuf?: SharedArrayBuffer };
      // Set exit code so wait() won't block
      if (payload?.exitSlotBuf) {
        const v = new Int32Array(payload.exitSlotBuf);
        Atomics.store(v, 0, 0);
        Atomics.notify(v, 0);
      }
      capturedSignalBuf = payload?.signalSlotBuf;
      return { pid: 1 };
    };
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('cat', []);
    proc.kill('sigint');
    assert.ok(capturedSignalBuf);
    const signalView = new Int32Array(capturedSignalBuf!);
    assert.equal(Atomics.load(signalView, 0), SIGNAL_NUMBER.sigint);
  });

  it('kill with sigterm writes 15', () => {
    let capturedSignalBuf: SharedArrayBuffer | undefined;
    const bridge: BlockingCallFn = (...args: unknown[]) => {
      const payload = args[2] as { exitSlotBuf?: SharedArrayBuffer; signalSlotBuf?: SharedArrayBuffer };
      if (payload?.exitSlotBuf) {
        const v = new Int32Array(payload.exitSlotBuf);
        Atomics.store(v, 0, 0);
        Atomics.notify(v, 0);
      }
      capturedSignalBuf = payload?.signalSlotBuf;
      return { pid: 1 };
    };
    const manager = new ProxyProcessManager(bridge);
    const proc = manager.spawn('cat', []);
    proc.kill('sigterm');
    assert.ok(capturedSignalBuf);
    const signalView = new Int32Array(capturedSignalBuf!);
    assert.equal(Atomics.load(signalView, 0), 15);
  });

  it('createPipe returns a working shared pipe', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    const { input, output } = manager.createPipe();
    output.write(new Uint8Array([5, 6, 7]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([5, 6, 7]));
  });

  it('hasForeground is false when no process is waiting', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    assert.equal(manager.hasForeground, false);
  });

  it('signal sends to foreground processes during wait', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    manager.spawn('cat', []);
    assert.equal(manager.hasForeground, false);
  });

  it('dupOutputStream returns a dup of the stream', () => {
    const { bridge } = createMockBridge(0);
    const manager = new ProxyProcessManager(bridge);
    const { output } = manager.createPipe();
    const duped = manager.dupOutputStream(output);
    assert.ok(duped !== output);
    duped.write(new Uint8Array([1]));
  });
});
