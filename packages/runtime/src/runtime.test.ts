import { expect, test } from 'vitest';
import { WORKER_CAPABILITIES, IFRAME_CAPABILITIES, QUICKJS_CAPABILITIES, IVM_CAPABILITIES } from './runtime.ts';

test('iframe is the only GUI-capable backend', () => {
  expect(IFRAME_CAPABILITIES.gui).toBe(true);
  expect(WORKER_CAPABILITIES.gui).toBe(false);
  expect(QUICKJS_CAPABILITIES.gui).toBe(false);
  expect(IVM_CAPABILITIES.gui).toBe(false);
});

test('quickjs and ivm enforce hard limits; iframe and worker do not', () => {
  expect(QUICKJS_CAPABILITIES.memoryLimit).toBe(true);
  expect(IVM_CAPABILITIES.memoryLimit).toBe(true);
  expect(IFRAME_CAPABILITIES.memoryLimit).toBe(false);
  expect(WORKER_CAPABILITIES.memoryLimit).toBe(false);
});

test('iframe and worker support direct pipes; quickjs and ivm do not', () => {
  expect(IFRAME_CAPABILITIES.directPipes).toBe(true);
  expect(WORKER_CAPABILITIES.directPipes).toBe(true);
  expect(QUICKJS_CAPABILITIES.directPipes).toBe(false);
  expect(IVM_CAPABILITIES.directPipes).toBe(false);
});

test('worker and iframe support transferables; quickjs and ivm do not', () => {
  expect(WORKER_CAPABILITIES.transferable).toBe(true);
  expect(IFRAME_CAPABILITIES.transferable).toBe(true);
  expect(QUICKJS_CAPABILITIES.transferable).toBe(false);
  expect(IVM_CAPABILITIES.transferable).toBe(false);
});

test('quickjs is deterministic; others are not', () => {
  expect(QUICKJS_CAPABILITIES.deterministic).toBe(true);
  expect(WORKER_CAPABILITIES.deterministic).toBe(false);
  expect(IFRAME_CAPABILITIES.deterministic).toBe(false);
  expect(IVM_CAPABILITIES.deterministic).toBe(false);
});

test('worker is interruptible; iframe is not', () => {
  expect(WORKER_CAPABILITIES.interruptible).toBe(true);
  expect(IFRAME_CAPABILITIES.interruptible).toBe(false);
  expect(QUICKJS_CAPABILITIES.interruptible).toBe(true);
  expect(IVM_CAPABILITIES.interruptible).toBe(true);
});

test('worker and iframe support parallelism; quickjs does not', () => {
  expect(WORKER_CAPABILITIES.parallelism).toBe(true);
  expect(IFRAME_CAPABILITIES.parallelism).toBe(true);
  expect(QUICKJS_CAPABILITIES.parallelism).toBe(false);
  expect(IVM_CAPABILITIES.parallelism).toBe(true);
});
