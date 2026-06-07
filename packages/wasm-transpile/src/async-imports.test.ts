import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAsyncImport, resolveVersionedImports, ASYNC_WASI_IMPORTS } from './async-imports.ts';

describe('matchesAsyncImport', () => {
  it('matches versioned module name against unversioned spec', () => {
    assert.equal(
      matchesAsyncImport('wasi:io/poll@0.2.0', '[method]pollable.block', ASYNC_WASI_IMPORTS),
      true,
    );
  });

  it('matches poll function', () => {
    assert.equal(
      matchesAsyncImport('wasi:io/poll@0.2.0', 'poll', ASYNC_WASI_IMPORTS),
      true,
    );
  });

  it('matches blocking-read on input-stream', () => {
    assert.equal(
      matchesAsyncImport('wasi:io/streams@0.2.0', '[method]input-stream.blocking-read', ASYNC_WASI_IMPORTS),
      true,
    );
  });

  it('matches mithic:process/types wait', () => {
    assert.equal(
      matchesAsyncImport('mithic:process/types@1.0.0', '[method]process.wait', ASYNC_WASI_IMPORTS),
      true,
    );
  });

  it('does not match non-async imports', () => {
    assert.equal(
      matchesAsyncImport('wasi:cli/environment@0.2.0', 'get-environment', ASYNC_WASI_IMPORTS),
      false,
    );
  });

  it('does not match unknown module', () => {
    assert.equal(
      matchesAsyncImport('wasi:random/random@0.2.0', 'get-random-u64', ASYNC_WASI_IMPORTS),
      false,
    );
  });

  it('does not match correct module but wrong function', () => {
    assert.equal(
      matchesAsyncImport('wasi:io/poll@0.2.0', 'nonexistent', ASYNC_WASI_IMPORTS),
      false,
    );
  });

  it('works with custom async imports list', () => {
    const custom = ['custom:pkg/iface#do-thing'];
    assert.equal(matchesAsyncImport('custom:pkg/iface@1.0.0', 'do-thing', custom), true);
    assert.equal(matchesAsyncImport('custom:pkg/iface@1.0.0', 'other', custom), false);
  });

  it('handles module name without version', () => {
    assert.equal(
      matchesAsyncImport('wasi:io/poll', '[method]pollable.block', ASYNC_WASI_IMPORTS),
      true,
    );
  });
});

describe('resolveVersionedImports', () => {
  it('produces versioned module.name strings for matching imports', () => {
    const moduleImports = [
      { module: 'wasi:io/poll@0.2.0', name: '[method]pollable.block' },
      { module: 'wasi:io/poll@0.2.0', name: 'poll' },
      { module: 'wasi:cli/environment@0.2.0', name: 'get-environment' },
      { module: 'wasi:io/streams@0.2.0', name: '[method]input-stream.blocking-read' },
    ];

    const result = resolveVersionedImports(moduleImports, ASYNC_WASI_IMPORTS);

    assert.deepEqual(result, [
      'wasi:io/poll@0.2.0.[method]pollable.block',
      'wasi:io/poll@0.2.0.poll',
      'wasi:io/streams@0.2.0.[method]input-stream.blocking-read',
    ]);
  });

  it('returns empty array when no imports match', () => {
    const moduleImports = [
      { module: 'wasi:cli/environment@0.2.0', name: 'get-environment' },
      { module: 'wasi:random/random@0.2.0', name: 'get-random-u64' },
    ];

    const result = resolveVersionedImports(moduleImports, ASYNC_WASI_IMPORTS);
    assert.deepEqual(result, []);
  });

  it('returns empty array for empty module imports', () => {
    const result = resolveVersionedImports([], ASYNC_WASI_IMPORTS);
    assert.deepEqual(result, []);
  });

  it('works with custom async imports list', () => {
    const moduleImports = [
      { module: 'custom:pkg/iface@2.0.0', name: 'blocking-op' },
      { module: 'custom:pkg/iface@2.0.0', name: 'sync-op' },
    ];

    const result = resolveVersionedImports(moduleImports, ['custom:pkg/iface#blocking-op']);
    assert.deepEqual(result, ['custom:pkg/iface@2.0.0.blocking-op']);
  });
});
