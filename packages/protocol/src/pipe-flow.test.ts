import { expect, test } from 'vitest';
import { PipeWriter, PipeReader, INITIAL_CREDIT_BYTES } from './index.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// --- PipeWriter: credit window ---

test('PipeWriter.reserve resolves immediately when credit is sufficient', async () => {
  const w = new PipeWriter();
  w.addCredit(100);
  await w.reserve(40);
  expect(w.credit).toBe(60);
  await w.reserve(60);
  expect(w.credit).toBe(0);
});

test('PipeWriter.reserve parks when credit is insufficient and wakes on replenish', async () => {
  const w = new PipeWriter();
  let resolved = false;
  const p = w.reserve(50).then(() => { resolved = true; });
  await tick();
  expect(resolved).toBe(false); // parked: no credit
  w.addCredit(20);
  await tick();
  expect(resolved).toBe(false); // still short (20 < 50)
  w.addCredit(30);
  await p;
  expect(resolved).toBe(true);
  expect(w.credit).toBe(0); // 50 consumed
});

test('PipeWriter wakes parked waiters in FIFO order', async () => {
  const w = new PipeWriter();
  const order: number[] = [];
  const p1 = w.reserve(10).then(() => order.push(1));
  const p2 = w.reserve(10).then(() => order.push(2));
  await tick();
  w.addCredit(20);
  await Promise.all([p1, p2]);
  expect(order).toEqual([1, 2]);
});

// --- PipeWriter: sticky-broken latch ---

test('PipeWriter.markBroken rejects a parked waiter immediately with the code', async () => {
  const w = new PipeWriter();
  const p = w.reserve(50);
  await tick();
  w.markBroken('EPIPE');
  await expect(p).rejects.toThrow('EPIPE');
});

test('PipeWriter sticky-broken: reserve AFTER markBroken rejects immediately', async () => {
  const w = new PipeWriter();
  w.addCredit(1000); // plenty of credit — would NOT park
  w.markBroken('EPIPE');
  expect(w.broken).toEqual({ code: 'EPIPE' });
  await expect(w.reserve(10)).rejects.toThrow('EPIPE'); // sticky despite credit
  await expect(w.reserve(1)).rejects.toThrow('EPIPE');  // stays broken
});

test('PipeWriter.markBroken is idempotent (first code wins)', async () => {
  const w = new PipeWriter();
  w.markBroken('EPIPE');
  w.markBroken('ECONNRESET');
  expect(w.broken).toEqual({ code: 'EPIPE' });
});

// --- PipeReader: sliding credit window ---

test('PipeReader.open grants the full window once', () => {
  const r = new PipeReader(INITIAL_CREDIT_BYTES);
  expect(r.open()).toBe(INITIAL_CREDIT_BYTES);
  // A second open() is a no-op (window already opened): grants nothing.
  expect(r.open()).toBe(0);
});

test('PipeReader replenishes only what was consumed, capped at the window', () => {
  const win = 100;
  const r = new PipeReader(win);
  expect(r.open()).toBe(win);          // outstanding = 100
  r.recordArrival(40);                  // outstanding = 60, consumedUncredited = 40
  r.recordArrival(60);                  // outstanding = 0, consumedUncredited = 100
  // Replenish: room = 100 - 0 = 100; consumed = 100 → grant 100.
  expect(r.replenish()).toBe(100);
  // Nothing consumed since → grant 0.
  expect(r.replenish()).toBe(0);
});

test('PipeReader never grants past the window (slow consumer caps outstanding)', () => {
  const win = 100;
  const r = new PipeReader(win);
  r.open();                 // outstanding = 100
  r.recordArrival(30);      // outstanding = 70, consumed = 30
  // room = 100 - 70 = 30; consumed = 30 → grant 30 (back to full window).
  expect(r.replenish()).toBe(30);
  // outstanding = 100 again, consumed flushed.
  expect(r.replenish()).toBe(0);
});

test('PipeReader default window is INITIAL_CREDIT_BYTES (64 KiB)', () => {
  const r = new PipeReader();
  expect(r.open()).toBe(INITIAL_CREDIT_BYTES);
});
