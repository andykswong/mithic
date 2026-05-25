import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { random, insecure, insecureSeed } from './index.ts';

describe('random', () => {
  it('getRandomBytes returns correct length', () => {
    const bytes = random.getRandomBytes(32n);
    assert.equal(bytes.length, 32);
    assert.ok(bytes instanceof Uint8Array);
  });

  it('getRandomBytes(0n) returns empty Uint8Array', () => {
    const bytes = random.getRandomBytes(0n);
    assert.equal(bytes.length, 0);
    assert.ok(bytes instanceof Uint8Array);
  });

  it('getRandomBytes returns different values on consecutive calls (probabilistic)', () => {
    const a = random.getRandomBytes(32n);
    const b = random.getRandomBytes(32n);
    // It is astronomically unlikely that two random 32-byte sequences are identical
    let same = true;
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    assert.equal(same, false);
  });

  it('getRandomBytes returns correct length for large sizes (tests chunking)', () => {
    const bytes = random.getRandomBytes(100000n);
    assert.equal(bytes.length, 100000);
    assert.ok(bytes instanceof Uint8Array);
  });

  it('getRandomU64 returns a bigint', () => {
    const value = random.getRandomU64();
    assert.equal(typeof value, 'bigint');
    assert.ok(value >= 0n);
    assert.ok(value < (1n << 64n));
  });

  it('getRandomU64 returns values within u64 range (>= 0)', () => {
    // Call multiple times to increase confidence
    for (let i = 0; i < 10; i++) {
      const value = random.getRandomU64();
      assert.ok(value >= 0n, `Expected >= 0, got ${value}`);
      assert.ok(value < (1n << 64n), `Expected < 2^64, got ${value}`);
    }
  });
});

describe('insecure', () => {
  it('getInsecureRandomBytes returns correct length', () => {
    const bytes = insecure.getInsecureRandomBytes(16n);
    assert.equal(bytes.length, 16);
    assert.ok(bytes instanceof Uint8Array);
  });

  it('getInsecureRandomU64 returns a bigint', () => {
    const value = insecure.getInsecureRandomU64();
    assert.equal(typeof value, 'bigint');
    assert.ok(value >= 0n);
    assert.ok(value < (1n << 64n));
  });
});

describe('insecureSeed', () => {
  it('insecureSeed returns tuple of two bigints', () => {
    const [a, b] = insecureSeed.insecureSeed();
    assert.equal(typeof a, 'bigint');
    assert.equal(typeof b, 'bigint');
    assert.ok(a >= 0n);
    assert.ok(a < (1n << 64n));
    assert.ok(b >= 0n);
    assert.ok(b < (1n << 64n));
  });
});
