import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { setupEnv } from '../env.ts';

const SCRIPT_URL = '/test.js?k1=v1&argv=a1&k2=v2&argv=a2';
const ENV = { k1: 'v1', k2: 'v2' };
const ARGV = [`file://${SCRIPT_URL}`, 'a1', 'a2'];

describe(setupEnv.name, () => {
  beforeEach(() => {
    jest.replaceProperty(globalThis, 'process', undefined as unknown as NodeJS.Process);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should set process', () => {
    setupEnv();
    expect(process.argv).toEqual([]);
    expect(process.env).toEqual({});
  });

  it('should set process.env and process.argv from location', () => {
    mockLocation();
    setupEnv();
    expect(process.argv).toEqual(ARGV);
    expect(process.env).toEqual(ENV);
  });

  function mockLocation() {
    globalThis.location = globalThis.location ?? undefined;
    jest.replaceProperty(globalThis, 'location', new URL(SCRIPT_URL, import.meta.url) as unknown as Location);
  }
});
