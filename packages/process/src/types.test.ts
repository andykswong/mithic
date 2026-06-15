import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Process, SIGNAL_NUMBER, type ProcessHandler, type Signal } from './types.ts';
import { Pollable } from '@mithic/wasip2/io/poll';

describe('Process', () => {
  function createMockHandler(exitCode = 0) {
    const handler = {
      killed: null as Signal | null,
      onKill(signal: Signal) { handler.killed = signal; },
      wait() { return exitCode; },
      tryWait() { return exitCode as number | undefined; },
    };
    return handler;
  }

  it('constructor creates Process with correct pid', () => {
    const handler = createMockHandler();
    const proc = new Process(42, handler);
    assert.equal(proc.pid(), 42);
  });

  it('wait() returns exit code', () => {
    const handler = createMockHandler(7);
    const proc = new Process(1, handler);
    const exitCode = proc.wait();
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

  it('tryWait() returns undefined when process not done', () => {
    const handler: ProcessHandler = {
      wait() { return 0; },
      tryWait() { return undefined; },
    };
    const proc = new Process(1, handler);
    assert.equal(proc.tryWait(), undefined);
  });

  it('tryWait() returns value from handler.tryWait', () => {
    const handler: ProcessHandler = {
      wait() { return 0; },
      tryWait() { return 42; },
    };
    const proc = new Process(1, handler);
    assert.equal(proc.tryWait(), 42);
  });

  it('waitAsync() delegates to handler.waitAsync', async () => {
    const proc = new Process(1, {
      onKill() {},
      wait() { return 0; },
      tryWait() { return 0; },
      waitAsync() { return Promise.resolve(42); },
    });
    assert.equal(await proc.waitAsync(), 42);
  });

  it('waitAsync() falls back to polling tryWait when handler lacks waitAsync', async () => {
    let exitCode: number | undefined;
    const proc = new Process(1, {
      onKill() {},
      wait() { return 0; },
      tryWait() { return exitCode; },
    });
    setTimeout(() => { exitCode = 7; }, 20);
    assert.equal(await proc.waitAsync(), 7);
  });

  it('subscribe() delegates to handler.subscribe', () => {
    const mockPollable = new Pollable(() => true, () => {});
    const proc = new Process(1, {
      wait() { return 0; },
      tryWait() { return 0; },
      subscribe() { return mockPollable; },
    });
    const pollable = proc.subscribe();
    assert.strictEqual(pollable, mockPollable);
  });

  it('subscribe() returns fallback pollable when handler lacks subscribe', () => {
    const proc = new Process(1, {
      wait() { return 0; },
      tryWait() { return 42; },
    });
    const pollable = proc.subscribe();
    assert.ok(pollable instanceof Pollable);
    assert.equal(pollable.ready(), true);
  });

  it('subscribe() fallback pollable is not ready when process running', () => {
    const proc = new Process(1, {
      wait() { return 0; },
      tryWait() { return undefined; },
    });
    const pollable = proc.subscribe();
    assert.equal(pollable.ready(), false);
  });
});

describe('SIGNAL_NUMBER', () => {
  it('maps sigterm to 15', () => { assert.equal(SIGNAL_NUMBER.sigterm, 15); });
  it('maps sigkill to 9', () => { assert.equal(SIGNAL_NUMBER.sigkill, 9); });
  it('maps sigint to 2', () => { assert.equal(SIGNAL_NUMBER.sigint, 2); });
  it('maps signull to 0', () => { assert.equal(SIGNAL_NUMBER.signull, 0); });
});
