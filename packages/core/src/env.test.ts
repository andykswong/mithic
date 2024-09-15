import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setupEnv } from './index.ts';

const SCRIPT_URL = '/test.js?k1=v1&argv=a1&k2=v2&argv=a2';
const ENV = { k1: 'v1', k2: 'v2' };
const ARGV = [`file://${SCRIPT_URL}`, 'a1', 'a2'];

describe('setupEnv', () => {
  const nodeProcess = process;

  beforeEach(() => {
    globalThis.process = undefined as unknown as NodeJS.Process;
  });

  afterEach(() => {
    globalThis.process = nodeProcess;
  });

  it('should set process', () => {
    setupEnv();
    assert.deepStrictEqual(process.argv, []);
    assert.deepStrictEqual(process.env, {});
  });

  it('should set process.env and process.argv from location', () => {
    mockLocation();
    setupEnv();
    assert.deepStrictEqual(process.argv, ARGV);
    assert.deepStrictEqual(process.env, ENV);
  });

  function mockLocation() {
    globalThis.location = new URL(SCRIPT_URL, import.meta.url) as unknown as Location;
  }
});
