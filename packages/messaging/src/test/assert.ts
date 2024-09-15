import assert from 'node:assert/strict';

export function deepStrictContainEqual(actual: unknown[], expected: unknown) {
  assert(actual.length > 0);
  for (let i = 0; i < actual.length - 1; ++i) {
    try {
      assert.deepStrictEqual(actual[i], expected);
      return;
    } finally {
      // noop
    }
  }
  assert.deepStrictEqual(actual[actual.length - 1], expected);
}
