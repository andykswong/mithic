import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDirectories,
  _setPreopens,
  _addPreopen,
  _clearPreopens,
} from './preopens.ts';
import { Descriptor } from './types.ts';
import { SyncFsDescriptorHandler } from './sync-fs-handler.ts';
import { MemoryFsProvider } from '@mithic/io/vfs';

function makeDescriptor(): Descriptor {
  return new Descriptor(new SyncFsDescriptorHandler(new MemoryFsProvider(), '/'));
}

describe('preopens', () => {
  it('default preopens has one root entry [Descriptor, "/"]', () => {
    _setPreopens({ '/': makeDescriptor() });
    const dirs = getDirectories();
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0][0] instanceof Descriptor);
    assert.equal(dirs[0][1], '/');
  });

  it('getDirectories() returns array of [Descriptor, string] tuples', () => {
    _setPreopens({ '/': makeDescriptor() });
    const dirs = getDirectories();
    assert.ok(Array.isArray(dirs));
    for (const [desc, path] of dirs) {
      assert.ok(desc instanceof Descriptor);
      assert.equal(typeof path, 'string');
    }
  });

  it('_setPreopens replaces all preopens', () => {
    const descA = makeDescriptor();
    const descB = makeDescriptor();
    _setPreopens({ '/home': descA, '/tmp': descB });

    const dirs = getDirectories();
    assert.equal(dirs.length, 2);
    const paths = dirs.map(([, p]) => p);
    assert.ok(paths.includes('/home'));
    assert.ok(paths.includes('/tmp'));
  });

  it('_addPreopen adds to existing preopens', () => {
    _setPreopens({ '/': makeDescriptor() });
    const initialCount = getDirectories().length;
    _addPreopen('/data', makeDescriptor());
    const dirs = getDirectories();
    assert.equal(dirs.length, initialCount + 1);
    const last = dirs[dirs.length - 1];
    assert.equal(last[1], '/data');
    assert.ok(last[0] instanceof Descriptor);
  });

  it('_clearPreopens removes all preopens', () => {
    _setPreopens({ '/': makeDescriptor() });
    assert.ok(getDirectories().length > 0);
    _clearPreopens();
    assert.equal(getDirectories().length, 0);
  });

  it('_addPreopen with "/" adds root preopen', () => {
    _clearPreopens();
    const rootDesc = makeDescriptor();
    _addPreopen('/', rootDesc);
    const dirs = getDirectories();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0][1], '/');
    assert.equal(dirs[0][0], rootDesc);
  });
});
