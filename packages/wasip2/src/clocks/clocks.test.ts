import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { monotonicClock, wallClock } from './index.ts';
import { Pollable } from '../io/poll.ts';

describe('monotonicClock', () => {
  it('now() returns a bigint > 0', () => {
    const value = monotonicClock.now();
    assert.equal(typeof value, 'bigint');
    assert.ok(value > 0n);
  });

  it('now() is monotonically increasing', () => {
    const first = monotonicClock.now();
    const second = monotonicClock.now();
    assert.ok(second >= first);
  });

  it('resolution() returns a bigint > 0', () => {
    const value = monotonicClock.resolution();
    assert.equal(typeof value, 'bigint');
    assert.ok(value > 0n);
  });

  it('subscribeInstant returns a Pollable', () => {
    const p = monotonicClock.subscribeInstant(0n);
    assert.ok(p instanceof Pollable);
  });

  it('subscribeInstant Pollable becomes ready when time has passed', () => {
    // Subscribe to instant 0 (in the past) should be immediately ready
    const p = monotonicClock.subscribeInstant(0n);
    assert.equal(p.ready(), true);
  });

  it('subscribeInstant with future time is not ready yet', () => {
    // Use a very large future instant
    const futureNs = monotonicClock.now() + 60_000_000_000n; // 60 seconds from now
    const p = monotonicClock.subscribeInstant(futureNs);
    assert.equal(p.ready(), false);
  });

  it('subscribeDuration returns a Pollable', () => {
    const p = monotonicClock.subscribeDuration(0n);
    assert.ok(p instanceof Pollable);
  });

  it('subscribeDuration with 0 duration is ready immediately', () => {
    const p = monotonicClock.subscribeDuration(0n);
    assert.equal(p.ready(), true);
  });

  it('subscribeDuration with large duration is not ready', () => {
    const p = monotonicClock.subscribeDuration(60_000_000_000n); // 60 seconds
    assert.equal(p.ready(), false);
  });
});

describe('wallClock', () => {
  it('now() returns { seconds: bigint, nanoseconds: number }', () => {
    const value = wallClock.now();
    assert.equal(typeof value.seconds, 'bigint');
    assert.equal(typeof value.nanoseconds, 'number');
    assert.ok(value.nanoseconds >= 0);
    assert.ok(value.nanoseconds < 1_000_000_000);
  });

  it('now().seconds is roughly current epoch time', () => {
    const value = wallClock.now();
    const expectedSeconds = BigInt(Math.floor(Date.now() / 1000));
    // Allow 2 seconds of difference
    assert.ok(value.seconds >= expectedSeconds - 2n);
    assert.ok(value.seconds <= expectedSeconds + 2n);
  });

  it('resolution() returns valid datetime format', () => {
    const value = wallClock.resolution();
    assert.equal(typeof value.seconds, 'bigint');
    assert.equal(typeof value.nanoseconds, 'number');
    assert.ok(value.nanoseconds >= 0);
    assert.ok(value.nanoseconds < 1_000_000_000);
    // Resolution should be positive (seconds or nanoseconds > 0)
    assert.ok(value.seconds > 0n || value.nanoseconds > 0);
  });
});
