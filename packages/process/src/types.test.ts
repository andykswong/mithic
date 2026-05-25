import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Process, SIGNAL_NUMBER, type ProcessHandler, type Signal } from './types.ts';

describe('Process', () => {
  function createMockHandler(exitCode = 0) {
    const handler = {
      killed: null as Signal | null,
      onKill(signal: Signal) { handler.killed = signal; },
      wait() { return Promise.resolve(exitCode); },
    };
    return handler;
  }

  it('constructor creates Process with correct pid', () => {
    const handler = createMockHandler();
    const proc = new Process(42, handler);
    assert.equal(proc.pid, 42);
  });

  it('wait() resolves with exit code', async () => {
    const handler = createMockHandler(7);
    const proc = new Process(1, handler);
    const exitCode = await proc.wait();
    assert.equal(exitCode, 7);
  });

  it('kill() calls onKill with signal', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    proc.kill('sigint');
    assert.equal(handler.killed, 'sigint');
  });

  it('kill() defaults to sigterm', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    proc.kill();
    assert.equal(handler.killed, 'sigterm');
  });

  it('kill() with no onKill handler does not throw', () => {
    const handler = createMockHandler();
    delete (handler as Partial<ProcessHandler>).onKill;
    const proc = new Process(1, handler);
    assert.doesNotThrow(() => proc.kill('sigkill'));
  });
});

describe('SIGNAL_NUMBER', () => {
  it('maps sigterm to 15', () => { assert.equal(SIGNAL_NUMBER.sigterm, 15); });
  it('maps sigkill to 9', () => { assert.equal(SIGNAL_NUMBER.sigkill, 9); });
  it('maps sigint to 2', () => { assert.equal(SIGNAL_NUMBER.sigint, 2); });
  it('maps signull to 0', () => { assert.equal(SIGNAL_NUMBER.signull, 0); });
});
